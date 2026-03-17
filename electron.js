const { app, BrowserWindow, shell, Menu } = require("electron");
const path = require("path");

const PORT = 3460;
let mainWindow;

// Set app name so macOS menu bar says "Autopilot"
app.name = "Autopilot";

// Standard macOS menu with copy/paste/select all
const template = [
  {
    label: "Autopilot",
    submenu: [
      { role: "about" },
      { type: "separator" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      { role: "quit" },
    ],
  },
  {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  },
  {
    label: "View",
    submenu: [
      { role: "reload" },
      { role: "toggleDevTools" },
      { type: "separator" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { role: "resetZoom" },
    ],
  },
];

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "Autopilot",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  win.loadURL(`http://localhost:${PORT}`);

  // Open external links in default browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.on("closed", () => {
    mainWindow = null;
  });

  return win;
}

app.on("ready", () => {
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  // Load server from this directory
  require(require("path").join(__dirname, "server.js"));

  // Wait for server to bind, then open window
  setTimeout(() => {
    mainWindow = createWindow();
  }, 2500);
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  if (!mainWindow) {
    mainWindow = createWindow();
  }
});
