import { app, Menu, shell, type MenuItemConstructorOptions } from 'electron'

export function buildAppMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [{ role: 'quit', label: 'Exit Magnetic' }]
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
