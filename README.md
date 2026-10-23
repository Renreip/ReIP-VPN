# ReIP VPN Client — Fast & Secure WireGuard Client

ReIP VPN Client is a lightweight, modern, and open-source WireGuard desktop client designed for Windows 10 and 11.

---

## Open Source & Transparency

Trust and privacy are our top priorities:
- **100% Open Source:** Inspect every line of code directly from this repository.
- **Zero Logging:** No user browsing logs, connection trackers, or hidden telemetry.
- **Clean Codebase:** Zero background webhooks, hidden tokens, or bloated third-party analytics.
- **3-Month Free Trial:** We offer 3 months of full free access so the community can test our speeds, security, and stability.

---

## Key Features

- **Next-Gen WireGuard Protocol:** Minimal overhead, ultra-low latency, and modern ChaCha20-Poly1305 encryption.
- **Client-Side Kill Switch:** Direct integration with the Windows Advanced Firewall to instantly block all network traffic if the tunnel drops.
- **Anti-DPI & Anti-Poisoning:** Hardened network stack to protect against Deep Packet Inspection and ISP DNS manipulation.
- **Modern Compact Interface:** Clean, vertical dashboard inspired by minimalist VPN standards.
- **Discord Rich Presence:** Shows your current connection status, live elapsed session timer, and masked IP address on your Discord profile.

---

## Download

Pre-compiled and digitally signed Windows installers are available on the **[Releases](../../releases)** tab.

1. Download **`ReIP VPN.exe`** from the latest release.
2. Run the installer and follow the setup wizard.
3. Launch ReIP VPN Client, enter your license key, and click **CONNECT**.

---

## Building from Source

### Prerequisites
- Node.js (v18 or higher recommended)
- npm
- Windows 10 / 11 64-bit

### Build Steps
```bash
# Clone the repository
git clone https://github.com/Renreip/ReIP-VPN.git
cd ReIP-VPN

# Install dependencies
npm install

# Start in development mode
npm start

# Compile and package the Windows installer
npm run build-win
```

The compiled installer will be located in the `dist/` directory as `ReIP VPN.exe`.

---

## License
This project is licensed under the MIT License.
