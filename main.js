const { app, BrowserWindow, ipcMain, dialog, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Readable } = require('stream');

const DATA_FILE = path.join(app.getPath('userData'), 'playlist-player-data.json');
const RENDERER_DIR = path.join(__dirname, 'renderer');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const VIDEO_MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.ogv': 'video/ogg'
};

function videoMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return VIDEO_MIME_TYPES[ext] || 'application/octet-stream';
}

const VIDEO_EXTENSIONS = ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v', 'wmv', 'flv', 'ogv'];
const MAX_FOLDER_SCAN_FILES = 2000;
const MAX_FOLDER_SCAN_DEPTH = 8;

async function scanFolderForVideos(rootDir) {
  const results = [];

  async function walk(dir, depth) {
    if (results.length >= MAX_FOLDER_SCAN_FILES || depth > MAX_FOLDER_SCAN_DEPTH) return;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      return;
    }
    // Keep the listing stable/predictable for the user.
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (results.length >= MAX_FOLDER_SCAN_FILES) return;
      if (entry.name.startsWith('.')) continue; // skip hidden files/folders

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase().replace(/^\./, '');
        if (VIDEO_EXTENSIONS.includes(ext)) {
          results.push(fullPath);
        }
      }
    }
  }

  await walk(rootDir, 0);
  return results;
}

// Local video files are streamed through this custom scheme instead of file://,
// because YouTube (and Chromium's media loader) treat file:// origins as
// untrusted once the page itself is served over http://. Registering it as
// "privileged" here (before app is ready) lets it behave like a normal,
// CORS-friendly, range-request-capable resource scheme.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'local-video',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
      bypassCSP: true
    }
  }
]);

// ---------- Local data file ----------

function readData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    return { playlists: [] };
  }
}

function writeData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ---------- Tiny local static server for the renderer ----------
// Serving over http://127.0.0.1 (instead of loading index.html via file://)
// gives the page a real origin, which is what fixes YouTube's
// "Error 153: video player configuration error" for embedded playback.

function startRendererServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const reqPath = decodeURIComponent(req.url.split('?')[0]);
        const relative = reqPath === '/' ? 'index.html' : reqPath.replace(/^\/+/, '');
        const filePath = path.normalize(path.join(RENDERER_DIR, relative));

        if (!filePath.startsWith(RENDERER_DIR)) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }

        fs.readFile(filePath, (err, data) => {
          if (err) {
            res.writeHead(404);
            res.end('Not found');
            return;
          }
          const ext = path.extname(filePath).toLowerCase();
          res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
          res.end(data);
        });
      } catch (err) {
        res.writeHead(500);
        res.end('Server error');
      }
    });

    server.listen(0, '127.0.0.1', () => {
      resolve(server.address().port);
    });
    server.on('error', reject);
  });
}

// ---------- Window ----------

let mainWindow;

async function createWindow() {
  const port = await startRendererServer();

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#16151A',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/index.html`);
}

app.whenReady().then(() => {
  // Serve local video files through our custom scheme so <video> elements
  // can stream them regardless of the page's own origin. We handle byte
  // ranges ourselves here — Electron's net.fetch() to a file:// URL does
  // NOT forward the incoming Range header (a known Electron limitation,
  // see electron/electron#38749), which is what breaks the seek bar:
  // without partial-content responses, Chromium can't jump to an
  // arbitrary point in the file.
  protocol.handle('local-video', async (request) => {
    try {
      const reqUrl = new URL(request.url);
      const filePath = decodeURIComponent(reqUrl.searchParams.get('path') || '');
      if (!filePath) {
        return new Response('Missing path', { status: 400 });
      }

      let stat;
      try {
        stat = await fs.promises.stat(filePath);
      } catch (err) {
        return new Response('File not found: ' + filePath, { status: 404 });
      }

      const fileSize = stat.size;
      const mimeType = videoMimeType(filePath);
      const rangeHeader = request.headers.get('range');

      if (rangeHeader) {
        const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
        let start = match && match[1] !== '' ? parseInt(match[1], 10) : 0;
        let end = match && match[2] !== '' ? parseInt(match[2], 10) : fileSize - 1;

        if (Number.isNaN(start) || start < 0) start = 0;
        if (Number.isNaN(end) || end > fileSize - 1) end = fileSize - 1;

        if (start > end || start >= fileSize) {
          return new Response(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${fileSize}` }
          });
        }

        const chunkSize = end - start + 1;
        const nodeStream = fs.createReadStream(filePath, { start, end });

        return new Response(Readable.toWeb(nodeStream), {
          status: 206,
          headers: {
            'Content-Type': mimeType,
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': String(chunkSize)
          }
        });
      }

      // No Range header: serve the whole file, but still advertise range
      // support so the player knows it's allowed to ask for byte ranges
      // (which is what enables scrubbing on the progress bar).
      const nodeStream = fs.createReadStream(filePath);
      return new Response(Readable.toWeb(nodeStream), {
        status: 200,
        headers: {
          'Content-Type': mimeType,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(fileSize)
        }
      });
    } catch (err) {
      return new Response('Error reading file: ' + String(err), { status: 500 });
    }
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('data:load', () => {
  return readData();
});

ipcMain.handle('data:save', (event, data) => {
  return writeData(data);
});

ipcMain.handle('dialog:selectVideoFiles', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Add local video files',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Video files', extensions: VIDEO_EXTENSIONS },
      { name: 'All files', extensions: ['*'] }
    ]
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('dialog:selectVideoFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Add all videos from a folder',
    properties: ['openDirectory']
  });
  if (result.canceled || result.filePaths.length === 0) return [];
  const files = await scanFolderForVideos(result.filePaths[0]);
  return files;
});

ipcMain.handle('dialog:importTextFile', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import video links from a text file',
    properties: ['openFile'],
    filters: [
      { name: 'Text files', extensions: ['txt'] },
      { name: 'All files', extensions: ['*'] }
    ]
  });
  if (result.canceled || result.filePaths.length === 0) return [];

  try {
    const raw = await fs.promises.readFile(result.filePaths[0], 'utf-8');
    return raw
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#'));
  } catch (err) {
    return [];
  }
});
