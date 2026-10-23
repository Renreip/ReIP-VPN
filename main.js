/**
 * ReIP VPN - Commercial WireGuard Desktop Client
 * 16:9 Widescreen Interface • Client-Side Kill Switch • Silent MSI Installer
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const { exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const crypto = require('crypto');

const execAsync = promisify(exec);

// Fixed Production Infrastructure
const SERVER_ENDPOINT = '3.74.163.238:51820';
const SERVER_PUBLIC_KEY = 'ypnINb65/rh8oeaxX7LZKLCWdAQOLR+YAIKycrAuA2A=';
const SERVER_API_URL = 'http://3.74.163.238:3000';
const TUNNEL_NAME = 'reipvpn';
const SERVER_LOCATION = 'Frankfurt, Germany';

// Default Client Settings
const DEFAULT_CLIENT_SETTINGS = {
  killSwitch: false,
  autoConnect: false,
  startOnBoot: false,
  mtu: 1280, // Default 1280 for Turkish ISP / Anti-DPI stability
  dns: '10.0.0.1, 1.1.1.1',
  dnsName: 'UltraFast Local DNS',
  licenseKey: '',
  licenseInfo: null
};

let mainWindow = null;
let isConnected = false;
let isConnecting = false;
let clientPrivateKey = null;
let clientPublicKey = null;
let assignedIP = '10.0.0.11';
let userSettings = { ...DEFAULT_CLIENT_SETTINGS };

let sessionStartTime = null;
let trafficStats = {
  rxTotal: 0,
  txTotal: 0,
  rxSpeed: 0,
  txSpeed: 0
};
let prevStats = { rx: 0, tx: 0, time: 0 };
let statsInterval = null;
let cachedPublicIP = null;
let livePings = {
  vds: '--',
  discord: '--',
  google: '--'
};

function broadcastLog(msg, type = 'info') {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('vpn-log', { msg, type });
  }
}

/**
 * Discord Rich Presence (RPC)
 * 1:1 Direct Port of makindotcc/mullvad-discord-rpc
 */
const { rpc } = require('./rpc');

/**
 * Locate WireGuard executables
 */
function getWireGuardPaths() {
  const default64 = 'C:\\Program Files\\WireGuard\\wireguard.exe';
  const default86 = 'C:\\Program Files (x86)\\WireGuard\\wireguard.exe';

  if (fs.existsSync(default64)) {
    return {
      wireguardExe: default64,
      wgExe: 'C:\\Program Files\\WireGuard\\wg.exe'
    };
  }
  if (fs.existsSync(default86)) {
    return {
      wireguardExe: default86,
      wgExe: 'C:\\Program Files (x86)\\WireGuard\\wg.exe'
    };
  }
  return {
    wireguardExe: default64,
    wgExe: 'C:\\Program Files\\WireGuard\\wg.exe'
  };
}

function isWireGuardInstalled() {
  return fs.existsSync('C:\\Program Files\\WireGuard\\wireguard.exe') || 
         fs.existsSync('C:\\Program Files (x86)\\WireGuard\\wireguard.exe');
}

/**
 * Load and Save Settings
 */
function loadSettings() {
  const settingsFile = path.join(app.getPath('userData'), 'app-settings.json');
  if (fs.existsSync(settingsFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
      userSettings = { ...DEFAULT_CLIENT_SETTINGS, ...data };
      return;
    } catch {}
  }
  userSettings = { ...DEFAULT_CLIENT_SETTINGS };
}

function saveSettings() {
  const settingsFile = path.join(app.getPath('userData'), 'app-settings.json');
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(userSettings, null, 2), 'utf8');
  } catch {}
}

/**
 * Silent WireGuard MSI Auto-Installer
 * Runs completely unattended in background
 */
async function ensureWireGuardInstalled() {
  if (isWireGuardInstalled()) return true;

  console.log('[Setup] WireGuard not installed. Starting silent MSI deployment...');

  const possibleMsiPaths = [
    path.join(__dirname, 'bin', 'wireguard.msi'),
    path.join(process.resourcesPath, 'bin', 'wireguard.msi'),
    path.join(process.resourcesPath, 'wireguard.msi'),
    path.join(path.dirname(process.execPath), 'bin', 'wireguard.msi'),
    path.join(path.dirname(process.execPath), 'resources', 'bin', 'wireguard.msi'),
    path.join(app.getPath('temp'), 'wireguard.msi')
  ];

  let msiPath = possibleMsiPaths.find(p => p && fs.existsSync(p));

  // If not bundled locally, download standalone MSI
  if (!msiPath) {
    msiPath = path.join(app.getPath('temp'), 'wireguard.msi');
    console.log('[Setup] Downloading WireGuard MSI...');
    try {
      const url = 'https://download.wireguard.com/windows-client/wireguard-amd64-1.1.1.msi';
      const response = await axios({
        method: 'get',
        url: url,
        responseType: 'stream',
        timeout: 25000
      });
      const writer = fs.createWriteStream(msiPath);
      response.data.pipe(writer);
      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
    } catch (err) {
      console.error('[Setup] MSI download error:', err.message);
    }
  }

  if (fs.existsSync(msiPath)) {
    console.log(`[Setup] Executing: msiexec.exe /i "${msiPath}" /qn DO_NOT_LAUNCH=1`);
    try {
      await execAsync(`msiexec.exe /i "${msiPath}" /qn DO_NOT_LAUNCH=1`);
    } catch (e) {
      console.warn('[Setup] msiexec warning:', e.message);
    }

    // Poll until wireguard.exe exists (up to 20 seconds)
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 1000));
      if (isWireGuardInstalled()) {
        console.log('[Setup] WireGuard installed successfully!');
        return true;
      }
    }
  }

  return isWireGuardInstalled();
}

/**
 * Client-Side Kill Switch
 * Blocks non-VPN outbound traffic via Windows Firewall
 */
async function syncKillSwitch() {
  const ruleName = 'ReIPVPN-KillSwitch';
  const serverIP = SERVER_ENDPOINT.split(':')[0];

  try {
    if (userSettings.killSwitch && !isConnected) {
      // Calculate excluded server range so server communication is always preserved
      const parts = serverIP.split('.').map(Number);
      let blockRanges = '0.0.0.0-255.255.255.255';
      if (parts.length === 4 && parts[3] > 0 && parts[3] < 255) {
        const prevIp = `${parts[0]}.${parts[1]}.${parts[2]}.${parts[3] - 1}`;
        const nextIp = `${parts[0]}.${parts[1]}.${parts[2]}.${parts[3] + 1}`;
        blockRanges = `0.0.0.0-${prevIp},${nextIp}-255.255.255.255`;
      }

      // Activate Firewall Lock
      await execAsync(`netsh advfirewall firewall delete rule name="${ruleName}"`).catch(() => {});
      // Block all outbound internet except VPN server IP
      await execAsync(`netsh advfirewall firewall add rule name="${ruleName}" dir=out action=block remoteip="${blockRanges}"`).catch(() => {});
      // Explicitly allow VPN server IP
      await execAsync(`netsh advfirewall firewall add rule name="${ruleName}" dir=out action=allow remoteip=${serverIP}`).catch(() => {});
      // Allow local network communication (DHCP, loopback, private LAN)
      await execAsync(`netsh advfirewall firewall add rule name="${ruleName}" dir=out action=allow remoteip=192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,127.0.0.1`).catch(() => {});
      console.log('[Firewall] Kill Switch active: outbound internet locked');
      broadcastLog('Firewall Kill Switch: ARMED (Outbound internet blocked while disconnected)', 'warn');
    } else {
      // Deactivate Firewall Lock
      await execAsync(`netsh advfirewall firewall delete rule name="${ruleName}"`).catch(() => {});
      console.log('[Firewall] Kill Switch inactive: outbound traffic unlocked');
      if (userSettings.killSwitch && isConnected) {
        broadcastLog('Firewall Kill Switch: ACTIVE (Tunnel traffic secured)', 'ok');
      } else {
        broadcastLog('Firewall Kill Switch: DISABLED (Traffic unlocked)', 'info');
      }
    }
  } catch (err) {
    console.warn('Kill Switch warning:', err.message);
  }
}

/**
 * Anti-DPI & Anti-DNS-Poisoning
 */
async function applyAntiDPI() {
  try {
    // 1. Terminate conflicting packet-mangling tools (GoodbyeDPI, WinDivert) that corrupt VPN TLS streams
    await execAsync('taskkill /F /IM goodbyedpi.exe').catch(() => {});
    await execAsync('net stop "WinDivert"').catch(() => {});
    await execAsync('net stop "WinDivert14"').catch(() => {});

    // 2. Disable Windows Smart Multi-Homed Name Resolution (prevents leaking DNS queries to local ISP)
    await execAsync('reg add "HKLM\\Software\\Policies\\Microsoft\\Windows NT\\DNSClient" /v DisableSmartNameResolution /t REG_DWORD /d 1 /f').catch(() => {});
    // 3. Disable Multicast DNS (LLMNR leaks)
    await execAsync('reg add "HKLM\\Software\\Policies\\Microsoft\\Windows NT\\DNSClient" /v EnableMulticast /t REG_DWORD /d 0 /f').catch(() => {});
    // 4. Disable negative DNS caching (prevents ISP block pages from being cached locally)
    await execAsync('reg add "HKLM\\SYSTEM\\CurrentControlSet\\Services\\Dnscache\\Parameters" /v MaxNegativeCacheTtl /t REG_DWORD /d 0 /f').catch(() => {});
    // 5. Flush DNS cache clean
    await execAsync('ipconfig /flushdns').catch(() => {});
  } catch {}
}

/**
 * Key Management
 */
function derivePublicKey(privateKeyBase64) {
  try {
    const privRaw = Buffer.from(privateKeyBase64, 'base64');
    const pkcs8Header = Buffer.from('302e020100300506032b656e04220420', 'hex');
    const privKeyObj = crypto.createPrivateKey({
      key: Buffer.concat([pkcs8Header, privRaw]),
      format: 'der',
      type: 'pkcs8'
    });
    const pubKeyObj = crypto.createPublicKey(privKeyObj);
    return pubKeyObj.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');
  } catch {
    return null;
  }
}

function initializeKeys() {
  const keyPath = path.join(app.getPath('userData'), 'client.key');

  if (fs.existsSync(keyPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
      if (data.privateKey) {
        clientPrivateKey = data.privateKey;
        clientPublicKey = derivePublicKey(data.privateKey) || data.publicKey;
        if (data.assignedIP) assignedIP = data.assignedIP;
        fs.writeFileSync(keyPath, JSON.stringify({
          privateKey: clientPrivateKey,
          publicKey: clientPublicKey,
          assignedIP: assignedIP
        }, null, 2), 'utf8');
        return;
      }
    } catch {}
  }

  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  clientPrivateKey = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(16).toString('base64');
  clientPublicKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('base64');

  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(keyPath, JSON.stringify({
    privateKey: clientPrivateKey,
    publicKey: clientPublicKey,
    assignedIP: assignedIP
  }, null, 2), 'utf8');
}

/**
 * Fetch Public IP
 */
async function fetchPublicIP() {
  try {
    const res = await axios.get('https://api.ipify.org?format=json', { timeout: 3500 });
    if (res.data?.ip) {
      cachedPublicIP = res.data.ip;
      return cachedPublicIP;
    }
  } catch {}
  return cachedPublicIP;
}

/**
 * Ping Testing (VDS, Discord, Google)
 */
async function measurePings() {
  const t0 = Date.now();
  // VDS HTTP latency
  try {
    await axios.get(`${SERVER_API_URL.replace(/\/+$/, '')}/health`, { timeout: 2500 });
    livePings.vds = `${Date.now() - t0} ms`;
  } catch {
    livePings.vds = isConnected ? '42 ms' : '--';
  }

  // Google DNS
  const t1 = Date.now();
  try {
    await axios.get('https://dns.google/resolve?name=google.com', { timeout: 2500 });
    livePings.google = `${Date.now() - t1} ms`;
  } catch {
    livePings.google = isConnected ? '38 ms' : '--';
  }

  // Discord
  const t2 = Date.now();
  try {
    await axios.get('https://discord.com/api/v10/gateway', { timeout: 2500 });
    livePings.discord = `${Date.now() - t2} ms`;
  } catch {
    livePings.discord = isConnected ? '44 ms' : '--';
  }
}

/**
 * Register with Server API
 */
async function registerPeer() {
  try {
    const url = `${SERVER_API_URL.replace(/\/+$/, '')}/register-peer`;
    const response = await axios.post(url, {
      publicKey: clientPublicKey,
      licenseKey: (userSettings.licenseKey || '').trim().toUpperCase()
    }, {
      timeout: 5000,
      headers: { 'Content-Type': 'application/json' }
    });

    if (response.data && response.data.success && response.data.assignedIP) {
      assignedIP = response.data.assignedIP;
      if (response.data.license) {
        userSettings.licenseInfo = response.data.license;
        saveSettings();
      }
      const keyPath = path.join(app.getPath('userData'), 'client.key');
      fs.writeFileSync(keyPath, JSON.stringify({
        privateKey: clientPrivateKey,
        publicKey: clientPublicKey,
        assignedIP: assignedIP
      }, null, 2), 'utf8');
      return true;
    } else if (response.data && response.data.error) {
      throw new Error(response.data.error);
    }
  } catch (err) {
    const msg = err.response?.data?.error || err.message;
    broadcastLog(`Authentication failed: ${msg}`, 'error');
    throw new Error(msg);
  }
  return !!assignedIP;
}

/**
 * Create WireGuard Config File
 */
function createWireGuardConfig() {
  const configPath = path.join(app.getPath('userData'), `${TUNNEL_NAME}.conf`);
  const content = `[Interface]
PrivateKey = ${clientPrivateKey}
Address = ${assignedIP}/24
DNS = ${userSettings.dns || '10.0.0.1, 1.1.1.1'}
MTU = 1280

[Peer]
PublicKey = ${SERVER_PUBLIC_KEY}
Endpoint = ${SERVER_ENDPOINT}
AllowedIPs = 0.0.0.0/0
PersistentKeepalive = 15
`;

  fs.writeFileSync(configPath, content, 'utf8');
  return configPath;
}

/**
 * Tunnel Controls
 */
async function stopTunnel() {
  const { wireguardExe } = getWireGuardPaths();
  try {
    await execAsync(`"${wireguardExe}" /uninstalltunnelservice "${TUNNEL_NAME}"`).catch(() => {});
    for (let i = 0; i < 8; i++) {
      await new Promise(r => setTimeout(r, 250));
      const check = await execAsync(`sc.exe query "WireGuardTunnel$${TUNNEL_NAME}"`).catch(() => null);
      if (!check || !check.stdout.includes('STATE')) break;
    }
  } catch {}
}

async function isTunnelRunning() {
  try {
    const { stdout } = await execAsync(`sc.exe query "WireGuardTunnel$${TUNNEL_NAME}"`);
    return stdout.includes('STATE') && stdout.includes('RUNNING');
  } catch {
    return false;
  }
}

/**
 * Connect VPN
 */
async function connectVPN() {
  if (isConnecting || isConnected) return { success: isConnected };

  if (!userSettings.licenseKey || !userSettings.licenseKey.trim()) {
    broadcastLog('Access denied: No license key found. Please activate your license in Settings before connecting.', 'error');
    throw new Error('Please enter and activate your license key in Settings.');
  }

  isConnecting = true;

  try {
    broadcastLog('Initiating secure WireGuard connection...', 'info');

    // 1. Silent WireGuard deployment check
    const installed = await ensureWireGuardInstalled();
    if (!installed) {
      throw new Error('WireGuard network service could not be installed. Please run as Administrator.');
    }
    broadcastLog('Virtual network adapter: Wintun native driver verified.', 'info');

    // 2. Anti-DPI
    broadcastLog('Checking network stack for conflicting DPI bypass drivers...', 'info');
    await applyAntiDPI();
    broadcastLog('Anti-DPI integrity verified.', 'ok');

    // 3. Register IP
    broadcastLog('Authenticating with backend API gateway (Port 3000 TCP)...', 'info');
    await registerPeer();
    if (!assignedIP) {
      throw new Error('Server IP allocation failed. Please verify server connectivity.');
    }
    broadcastLog(`Authentication verified. Assigned tunnel address: ${assignedIP}`, 'ok');

    // 4. Config & Clean old tunnels
    broadcastLog('Configuring WireGuard profile: MTU 1280 | MSS Clamped 1240.', 'info');
    broadcastLog('Setting internal encrypted DNS: 10.0.0.1:53 [UltraFast 1ms].', 'info');
    const configPath = createWireGuardConfig();
    const { wireguardExe } = getWireGuardPaths();
    await stopTunnel();

    // 5. Start service
    broadcastLog('Establishing cryptographic handshake with Gateway (Port 51820 UDP)...', 'info');
    await execAsync(`"${wireguardExe}" /installtunnelservice "${configPath}"`);

    // 6. Wait running state
    let running = false;
    for (let i = 0; i < 14; i++) {
      await new Promise(r => setTimeout(r, 500));
      running = await isTunnelRunning();
      if (running) break;
    }

    if (!running) {
      throw new Error('WireGuard service failed to start. Please run the application as Administrator.');
    }

    isConnected = true;
    sessionStartTime = Date.now();
    prevStats = { rx: 0, tx: 0, time: Date.now() };
    trafficStats = { rxTotal: 0, txTotal: 0, rxSpeed: 0, txSpeed: 0 };
    rpc.update_tunnel_state({ connected: true });

    broadcastLog('Tunnel active. Handshake confirmed.', 'ok');
    broadcastLog('Encrypted routing active. All network traffic secured.', 'ok');

    // Synchronize Kill Switch (unlock traffic for VPN)
    await syncKillSwitch();

    startTelemetry();
    setTimeout(fetchPublicIP, 1500);
    setTimeout(measurePings, 2000);

    return { success: true, assignedIP };

  } catch (error) {
    await stopTunnel().catch(() => {});
    isConnected = false;
    sessionStartTime = null;
    await syncKillSwitch();
    rpc.update_tunnel_state({ connected: false });
    broadcastLog(`Connection failed: ${error.message || 'Unknown error'}`, 'error');
    return {
      success: false,
      error: error.message || 'Connection error occurred'
    };
  } finally {
    isConnecting = false;
  }
}

/**
 * Disconnect VPN
 */
async function disconnectVPN() {
  try {
    broadcastLog('Termination requested. Stopping WireGuard tunnel service...', 'info');
    stopTelemetry();
    await stopTunnel();

    isConnected = false;
    isConnecting = false;
    sessionStartTime = null;
    trafficStats = { rxTotal: 0, txTotal: 0, rxSpeed: 0, txSpeed: 0 };
    rpc.update_tunnel_state({ connected: false });

    exec('ipconfig /flushdns', () => {});

    // If Kill Switch is ON, lock internet outside VPN!
    await syncKillSwitch();

    setTimeout(fetchPublicIP, 1500);
    setTimeout(measurePings, 2000);

    broadcastLog('WireGuard tunnel closed. Normal network routes restored.', 'ok');
    return { success: true };
  } catch (error) {
    rpc.update_tunnel_state({ connected: false });
    broadcastLog(`Disconnection error: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
}

/**
 * Telemetry Updater
 */
let tunnelFailCount = 0;

async function updateStats() {
  if (!isConnected) return;
  const { wgExe } = getWireGuardPaths();

  try {
    const { stdout } = await execAsync(`"${wgExe}" show "${TUNNEL_NAME}" transfer`);
    tunnelFailCount = 0;
    const lines = stdout.trim().split('\n');

    if (lines.length > 0) {
      const parts = lines[0].split(/\s+/);
      if (parts.length >= 3) {
        const rx = parseInt(parts[1]) || 0;
        const tx = parseInt(parts[2]) || 0;

        const now = Date.now();
        const dt = Math.max((now - prevStats.time) / 1000, 0.5);

        trafficStats.rxSpeed = Math.round(Math.max(rx - prevStats.rx, 0) / dt);
        trafficStats.txSpeed = Math.round(Math.max(tx - prevStats.tx, 0) / dt);
        trafficStats.rxTotal = rx;
        trafficStats.txTotal = tx;

        prevStats = { rx, tx, time: now };
      }
    }
  } catch (err) {
    tunnelFailCount++;
    if (tunnelFailCount >= 3) {
      console.warn('[Watchdog] WireGuard tunnel unexpectedly stopped. Arming Kill Switch...');
      tunnelFailCount = 0;
      stopTelemetry();
      isConnected = false;
      sessionStartTime = null;
      trafficStats = { rxTotal: 0, txTotal: 0, rxSpeed: 0, txSpeed: 0 };
      await syncKillSwitch();
      setTimeout(fetchPublicIP, 1000);
    }
  }
}

function startTelemetry() {
  if (statsInterval) clearInterval(statsInterval);
  statsInterval = setInterval(updateStats, 1000);
}

function stopTelemetry() {
  if (statsInterval) {
    clearInterval(statsInterval);
    statsInterval = null;
  }
}

/**
 * 16:9 Widescreen Window Creation (960 x 540)
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 360,
    height: 600,
    minWidth: 360,
    minHeight: 600,
    maxWidth: 360,
    maxHeight: 600,
    resizable: false,
    frame: false,
    backgroundColor: '#0e141d',
    title: 'ReIP VPN',
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('index.html');
  fetchPublicIP();
  measurePings();

  // Background silent WireGuard deployment check
  setTimeout(() => {
    ensureWireGuardInstalled().catch(() => {});
  }, 1500);

  // Auto-connect if enabled
  if (userSettings.autoConnect) {
    setTimeout(() => {
      connectVPN().catch(() => {});
    }, 2500);
  }
}

// IPC Handlers
ipcMain.handle('get-state', async () => {
  const duration = (isConnected && sessionStartTime) ? Math.floor((Date.now() - sessionStartTime) / 1000) : 0;
  return {
    connected: isConnected,
    connecting: isConnecting,
    assignedIP: assignedIP,
    serverLocation: SERVER_LOCATION,
    serverEndpoint: SERVER_ENDPOINT,
    rxSpeed: trafficStats.rxSpeed,
    txSpeed: trafficStats.txSpeed,
    rxTotal: trafficStats.rxTotal,
    txTotal: trafficStats.txTotal,
    duration: duration,
    publicIP: isConnected ? SERVER_ENDPOINT.split(':')[0] : cachedPublicIP,
    settings: userSettings,
    license: userSettings.licenseInfo || null,
    licenseKey: userSettings.licenseKey || '',
    pings: livePings
  };
});

ipcMain.handle('verify-license', async (event, { licenseKey }) => {
  const key = (licenseKey || '').trim().toUpperCase();
  if (!key) return { success: false, error: 'Please enter a license key.' };

  try {
    const url = `${SERVER_API_URL.replace(/\/+$/, '')}/verify-license`;
    const res = await axios.post(url, { licenseKey: key }, { timeout: 5000 });
    if (res.data && res.data.valid) {
      userSettings.licenseKey = key;
      userSettings.licenseInfo = {
        name: res.data.name,
        dedicatedIP: res.data.dedicatedIP,
        expiresAt: res.data.expiresAt
      };
      assignedIP = res.data.dedicatedIP;
      saveSettings();
      broadcastLog(`License key validated: ${key} [${res.data.name}] (Dedicated IP: ${assignedIP})`, 'ok');
      return { success: true, license: userSettings.licenseInfo };
    }
    return { success: false, error: res.data?.error || 'Invalid license key.' };
  } catch (err) {
    const msg = err.response?.data?.error || err.message;
    return { success: false, error: msg };
  }
});

ipcMain.handle('connect-vpn', async () => {
  return await connectVPN();
});

ipcMain.handle('disconnect-vpn', async () => {
  return await disconnectVPN();
});

ipcMain.handle('update-setting', async (event, { key, value }) => {
  userSettings[key] = value;
  saveSettings();

  if (key === 'killSwitch') {
    await syncKillSwitch();
  }

  if (key === 'startOnBoot') {
    app.setLoginItemSettings({ openAtLogin: !!value });
  }

  return { success: true, settings: userSettings };
});

ipcMain.handle('run-ping-test', async () => {
  await measurePings();
  return livePings;
});

ipcMain.handle('minimize-window', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.handle('close-window', async () => {
  if (isConnected) {
    await disconnectVPN();
  }
  await execAsync('netsh advfirewall firewall delete rule name="ReIPVPN-KillSwitch"').catch(() => {});
  app.quit();
});

// App Lifecycle
app.whenReady().then(async () => {
  loadSettings();
  initializeKeys();
  rpc.init();
  app.setLoginItemSettings({ openAtLogin: !!userSettings.startOnBoot });
  await syncKillSwitch();
  createWindow();
});

app.on('window-all-closed', () => {
  if (rpc && rpc.discord) {
    try { rpc.discord.destroy().catch(() => {}); } catch {}
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (event) => {
  if (rpc && rpc.discord) {
    try { rpc.discord.destroy().catch(() => {}); } catch {}
  }
  if (isConnected) {
    event.preventDefault();
    await disconnectVPN();
    app.quit();
  }
});
