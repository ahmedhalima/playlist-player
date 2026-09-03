const { app, BrowserWindow, ipcMain, dialog, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { pathToFileURL } = require('url');

const DATA_FILE = path.join(app.getPath('userData'), 'reel-list-data.json');
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
    width: 1180,
    height: 760,
    minWidth: 860,
    minHeight: 560,
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
  // can stream them (with proper Range support for seeking) regardless of
  // the page's own origin.
  protocol.handle('local-video', (request) => {
    try {
      const reqUrl = new URL(request.url);
      const filePath = decodeURIComponent(reqUrl.searchParams.get('path') || '');
      if (!filePath) {
        return new Response('Missing path', { status: 400 });
      }
      return net.fetch(pathToFileURL(filePath).toString());
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
      { name: 'Video files', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v', 'wmv', 'flv', 'ogv'] },
      { name: 'All files', extensions: ['*'] }
    ]
  });
  return result.canceled ? [] : result.filePaths;
});
