import { app, BrowserWindow, ipcMain, dialog, protocol, Tray, Menu, nativeImage, net } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { pathToFileURL } from 'url';
import initSqlJs from 'sql.js';
import { runImport, createQueryDb, createMutationDb } from './import-worker';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let queryDb: ReturnType<typeof createQueryDb> | null = null;
let mutationDb: ReturnType<typeof createMutationDb> | null = null;
let sqlInstance: any = null;
let isQuitting = false;

// Paths
let currentFolder: string | null = null;
let generationsDir: string | null = null;
let galleryDataDir: string | null = null;
let dbPath: string | null = null;
let thumbDir: string | null = null;

const settingsPath = path.join(app.getPath('userData'), 'settings.json');

function loadSettings(): { lastFolder?: string } {
  try {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch {
    return {};
  }
}

function saveSettings(settings: any): void {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

function setupPaths(folder: string): void {
  currentFolder = folder;
  generationsDir = path.join(folder, 'generations');
  galleryDataDir = path.join(folder, 'gallery-data');
  dbPath = path.join(galleryDataDir, 'gallery.db');
  thumbDir = path.join(galleryDataDir, 'thumbs');
}

function closeDbs(): void {
  try { queryDb?.close(); } catch {}
  try { mutationDb?.close(); } catch {}
  queryDb = null;
  mutationDb = null;
}

function openDbs(): void {
  closeDbs();
  if (dbPath && generationsDir && thumbDir && sqlInstance) {
    queryDb = createQueryDb(dbPath, sqlInstance);
    mutationDb = createMutationDb(dbPath, generationsDir, thumbDir, sqlInstance);
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#18181b',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  // If we already have a db loaded, go straight to gallery
  const settings = loadSettings();
  if (settings.lastFolder && dbPath && fs.existsSync(dbPath)) {
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'gallery.html'));
  } else {
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });
}

function createTray(): void {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.ico');
  let icon: Electron.NativeImage;
  if (fs.existsSync(iconPath)) {
    icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  } else {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip('Sora Gallery');
  tray.on('click', () => {
    if (mainWindow?.isVisible()) mainWindow.hide();
    else mainWindow?.show();
  });

  const menu = Menu.buildFromTemplate([
    { label: 'Show Gallery', click: () => mainWindow?.show() },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
}

// Register custom protocol for serving local media files
function registerProtocol(): void {
  protocol.handle('sora-media', async (request) => {
    const url = new URL(request.url);
    // sora-media://thumb/genId → host='thumb', pathname='/genId'
    const type = url.hostname;
    const pathParts = url.pathname.replace(/^\/+/, '').split('/');

    if (!currentFolder) {
      return new Response('No folder selected', { status: 404 });
    }

    // sora-media://thumb/{genId}
    if (type === 'thumb' && pathParts[0]) {
      const filePath = path.join(thumbDir!, `${pathParts[0]}.webp`);
      try {
        return net.fetch(pathToFileURL(filePath).href);
      } catch {
        return new Response('Not found', { status: 404 });
      }
    }

    // sora-media://media/{genId}/{filename}
    if (type === 'media' && pathParts[0] && pathParts[1]) {
      const filename = pathParts[1];
      if (filename.includes('..')) return new Response('Bad request', { status: 400 });
      const filePath = path.join(generationsDir!, pathParts[0], filename);
      try {
        return net.fetch(pathToFileURL(filePath).href);
      } catch {
        return new Response('Not found', { status: 404 });
      }
    }

    // sora-media://trash/{genId}/{filename}
    if (type === 'trash' && pathParts[0] && pathParts[1]) {
      const filename = pathParts[1];
      if (filename.includes('..')) return new Response('Bad request', { status: 400 });
      const trashPath = path.join(currentFolder, 'trash', pathParts[0], filename);
      try {
        return net.fetch(pathToFileURL(trashPath).href);
      } catch {
        return new Response('Not found', { status: 404 });
      }
    }

    return new Response('Not found', { status: 404 });
  });
}

// IPC Handlers
function setupIpc(): void {
  ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Select your Sora export folder',
      properties: ['openDirectory'],
      buttonLabel: 'Open Gallery'
    });

    if (result.canceled || result.filePaths.length === 0) return null;

    const folder = result.filePaths[0];
    const genDir = path.join(folder, 'generations');
    if (!fs.existsSync(genDir)) {
      dialog.showErrorBox(
        'Invalid folder',
        'This folder doesn\'t contain a "generations" subfolder. Make sure you selected your sora-export folder.'
      );
      return null;
    }

    return folder;
  });

  ipcMain.handle('get-last-folder', () => {
    const settings = loadSettings();
    if (settings.lastFolder && fs.existsSync(path.join(settings.lastFolder, 'generations'))) {
      return settings.lastFolder;
    }
    return null;
  });

  ipcMain.handle('start-import', async (_event, folderPath: string) => {
    setupPaths(folderPath);
    fs.mkdirSync(galleryDataDir!, { recursive: true });

    closeDbs();

    await runImport(dbPath!, thumbDir!, generationsDir!, (progress) => {
      mainWindow?.webContents.send('import-progress', progress);
    });

    saveSettings({ lastFolder: folderPath });
    openDbs();
    return true;
  });

  ipcMain.handle('change-folder', async () => {
    closeDbs();
    currentFolder = null;
    saveSettings({ lastFolder: null });
    mainWindow?.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    return true;
  });

  // Query handlers
  ipcMain.handle('get-generations', (_event, filters: any) => {
    if (!queryDb) return { generations: [], total: 0 };
    return queryDb.getGenerations(filters);
  });

  ipcMain.handle('search', (_event, query: string, page: number) => {
    if (!queryDb) return { generations: [], total: 0 };
    return queryDb.search(query, page);
  });

  ipcMain.handle('get-generation', (_event, id: string) => {
    if (!queryDb) return null;
    return queryDb.getGeneration(id);
  });

  ipcMain.handle('get-task', (_event, taskId: string) => {
    if (!queryDb) return { task_id: taskId, variants: [], count: 0 };
    return queryDb.getTask(taskId);
  });

  ipcMain.handle('get-stats', () => {
    if (!queryDb) return null;
    return queryDb.getStats();
  });

  // Mutation handlers
  ipcMain.handle('delete-generation', (_event, genId: string) => {
    if (!mutationDb) return { success: false, error: 'No database' };
    const result = mutationDb.deleteGeneration(genId);
    if (result.success && sqlInstance) {
      try { queryDb?.close(); } catch {}
      queryDb = createQueryDb(dbPath!, sqlInstance);
    }
    return result;
  });

  ipcMain.handle('restore-generation', (_event, genId: string) => {
    if (!mutationDb) return { success: false, error: 'No database' };
    const result = mutationDb.restoreGeneration(genId);
    if (result.success && sqlInstance) {
      try { queryDb?.close(); } catch {}
      queryDb = createQueryDb(dbPath!, sqlInstance);
    }
    return result;
  });

  ipcMain.handle('get-trash', () => {
    if (!mutationDb) return { items: [], count: 0 };
    return mutationDb.getTrash();
  });

  ipcMain.handle('trash-delete', (_event, genId: string) => {
    if (!mutationDb) return { success: false };
    return mutationDb.trashDelete(genId);
  });

  ipcMain.handle('empty-trash', () => {
    if (!mutationDb) return { success: false };
    return mutationDb.emptyTrash();
  });
}

// App lifecycle
app.whenReady().then(async () => {
  // Initialize sql.js
  sqlInstance = await initSqlJs({
    locateFile: (file: string) => {
      const paths = [
        path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file),
        path.join(__dirname, '..', '..', 'node_modules', 'sql.js', 'dist', file),
        path.join(process.resourcesPath || '', 'app', 'node_modules', 'sql.js', 'dist', file),
      ];
      for (const p of paths) {
        if (fs.existsSync(p)) return p;
      }
      return file;
    }
  });

  registerProtocol();
  setupIpc();

  // Auto-load last folder if available
  const settings = loadSettings();
  if (settings.lastFolder && fs.existsSync(path.join(settings.lastFolder, 'generations'))) {
    setupPaths(settings.lastFolder);
    if (fs.existsSync(dbPath!)) {
      openDbs();
    }
  }

  createWindow();
  createTray();
});

app.on('before-quit', () => {
  isQuitting = true;
  closeDbs();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    isQuitting = true;
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
