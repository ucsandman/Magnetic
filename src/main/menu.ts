import { app, BrowserWindow, ipcMain, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { IPC } from '../shared/channels'

export interface MenuActions {
  onImportMedia(): void
}

function sendEditCommand(command: 'undo' | 'redo'): void {
  BrowserWindow.getFocusedWindow()?.webContents.send(IPC.editCommand, command)
}

/** Renderer reports undo/redo availability; mirror it onto the menu items. */
export function watchEditState(): void {
  ipcMain.on(IPC.editStateChanged, (_event, state: { canUndo: boolean; canRedo: boolean }) => {
    const menu = Menu.getApplicationMenu()
    if (menu === null) return
    const undoItem = menu.getMenuItemById('edit-undo')
    const redoItem = menu.getMenuItemById('edit-redo')
    if (undoItem !== null) undoItem.enabled = state.canUndo === true
    if (redoItem !== null) redoItem.enabled = state.canRedo === true
  })
}

export function buildAppMenu(actions: MenuActions): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Import Media…',
          accelerator: 'CmdOrCtrl+I',
          click: () => actions.onImportMedia()
        },
        { type: 'separator' },
        { role: 'quit', label: 'Exit Magnetic' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        {
          id: 'edit-undo',
          label: 'Undo',
          accelerator: 'CmdOrCtrl+Z',
          enabled: false,
          click: () => sendEditCommand('undo')
        },
        {
          id: 'edit-redo',
          label: 'Redo',
          accelerator: 'CmdOrCtrl+Shift+Z',
          enabled: false,
          click: () => sendEditCommand('redo')
        },
        { type: 'separator' },
        { role: 'cut' },
        // Keep the menu items (text-field copy/paste on click) but do NOT
        // register their accelerators: Ctrl+C/Ctrl+V must reach the renderer,
        // where Chromium handles text fields natively and the shortcut
        // registry handles timeline clip copy/paste (TimelinePanel.tsx).
        { role: 'copy', registerAccelerator: false },
        { role: 'paste', registerAccelerator: false },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About Magnetic',
          click: () => {
            void shell.openExternal('https://github.com/ucsandman/magnetic')
          }
        },
        { label: `Version ${app.getVersion()}`, enabled: false }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
