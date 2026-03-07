import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('soraGallery', {
  // Folder selection
  selectFolder: () => ipcRenderer.invoke('select-folder'),
  getLastFolder: () => ipcRenderer.invoke('get-last-folder'),

  // Import
  startImport: (folderPath: string) => ipcRenderer.invoke('start-import', folderPath),
  onImportProgress: (cb: (progress: any) => void) => {
    ipcRenderer.on('import-progress', (_e, progress) => cb(progress));
  },

  // Gallery queries
  getGenerations: (filters: any) => ipcRenderer.invoke('get-generations', filters),
  search: (query: string, page: number) => ipcRenderer.invoke('search', query, page),
  getGeneration: (id: string) => ipcRenderer.invoke('get-generation', id),
  getTask: (taskId: string) => ipcRenderer.invoke('get-task', taskId),
  getStats: () => ipcRenderer.invoke('get-stats'),

  // Mutations
  deleteGeneration: (genId: string) => ipcRenderer.invoke('delete-generation', genId),
  restoreGeneration: (genId: string) => ipcRenderer.invoke('restore-generation', genId),
  getTrash: () => ipcRenderer.invoke('get-trash'),
  trashDelete: (genId: string) => ipcRenderer.invoke('trash-delete', genId),
  emptyTrash: () => ipcRenderer.invoke('empty-trash'),

  // Media URLs
  getMediaUrl: (genId: string, filename: string) => `sora-media://media/${genId}/${filename}`,
  getThumbUrl: (genId: string) => `sora-media://thumb/${genId}`,
  getTrashMediaUrl: (genId: string, filename: string) => `sora-media://trash/${genId}/${filename}`,

  // App control
  changeFolder: () => ipcRenderer.invoke('change-folder'),
});
