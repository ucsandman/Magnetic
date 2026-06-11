import { app, Menu, shell, type MenuItemConstructorOptions } from 'electron'

export interface MenuActions {
  onImportMedia(): void
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
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
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
