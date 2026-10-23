/**
 * Discord Rich Presence for ReIP VPN
 * 1:1 Port of makindotcc/mullvad-discord-rpc
 * https://github.com/makindotcc/mullvad-discord-rpc
 */

const DiscordRPC = require('discord-rpc');
const axios = require('axios');

// ReIP VPN Application ID (matches mullvad-discord-rpc APP_ID = 1015745829954404362)
const APP_ID = '1560425969746186250';

const RELAY_INFO = {
  hostname: 'reip-de1',
  country: 'Germany',
  city: 'Frankfurt'
};

class RpcActive {
  constructor(relay_info) {
    this.started_at = Date.now();
    this.relay_info = relay_info;
  }

  static start_now(relay_info) {
    return new RpcActive(relay_info);
  }
}

const RpcState = {
  Inactive: 'Inactive',
  Active: 'Active'
};

function censor_ip(ip) {
  if (!ip || typeof ip !== 'string') return 'xxx.xxx.xxx.xxx';
  const parts = ip.trim().split('.');
  if (parts.length === 4) {
    const p2Mask = 'x'.repeat(Math.max(parts[2].length, 2));
    const p3Mask = 'x'.repeat(Math.max(parts[3].length, 2));
    return `${parts[0]}.${parts[1]}.${p2Mask}.${p3Mask}`;
  }
  return 'xxx.xxx.xxx.xxx';
}

function activity_state(relay_info) {
  if (relay_info && relay_info.country && relay_info.city && relay_info.hostname) {
    return `Secure connection to ${relay_info.country}/${relay_info.city}/${relay_info.hostname}`;
  }
  return 'Secure connection';
}

function build_activity(relay_info, real_ip, started_at) {
  const host_display = censor_ip(real_ip);
  return {
    largeImageKey: 'dfd7f849509ae139e9dd603f522f3dce',
    largeImageText: 'ReIP VPN',
    details: `Host: ${host_display}`,
    state: activity_state(relay_info),
    startTimestamp: started_at ? new Date(started_at) : new Date(),
    instance: false
  };
}

class Rpc {
  constructor() {
    this.discord = null;
    this.state = RpcState.Inactive;
    this.active = null;
    this.real_ip = null;
    this.pending_tunnel_state = null;
  }

  async init() {
    await this.connect_to_discord();
    this.fetch_real_ip();
  }

  async connect_to_discord() {
    if (this.discord) return;
    try {
      DiscordRPC.register(APP_ID);
      this.discord = new DiscordRPC.Client({ transport: 'ipc' });

      this.discord.on('ready', async () => {
        console.log('[Discord RPC] Connected to Discord as', this.discord.user?.username);
        if (this.pending_tunnel_state !== null) {
          await this.update_tunnel_state(this.pending_tunnel_state);
        } else if (this.state === RpcState.Active) {
          await this.sync();
        }
      });

      this.discord.on('disconnected', () => {
        this.discord = null;
        setTimeout(() => this.connect_to_discord(), 15000);
      });

      await this.discord.login({ clientId: APP_ID }).catch(() => {
        this.discord = null;
        setTimeout(() => this.connect_to_discord(), 30000);
      });
    } catch (err) {
      this.discord = null;
    }
  }

  async fetch_real_ip() {
    try {
      const res = await axios.get('https://api.ipify.org?format=json', { timeout: 3500 });
      if (res.data?.ip) {
        this.real_ip = res.data.ip;
        if (this.state === RpcState.Active) {
          await this.sync();
        }
      }
    } catch {}
  }

  update_relay(relay_info) {
    if (this.state === RpcState.Inactive || !this.active) {
      return RpcActive.start_now(relay_info);
    }
    if (this.active.relay_info?.hostname !== relay_info?.hostname) {
      return RpcActive.start_now(relay_info);
    }
    return this.active;
  }

  async update_tunnel_state(tunnel_state) {
    this.pending_tunnel_state = tunnel_state;

    if (tunnel_state && tunnel_state.connected) {
      const relay_info = tunnel_state.relay_info || RELAY_INFO;
      this.active = this.update_relay(relay_info);
      this.state = RpcState.Active;
      await this.sync();
    } else {
      if (this.state === RpcState.Active) {
        this.state = RpcState.Inactive;
        this.active = null;
        if (this.discord) {
          try {
            await this.discord.clearActivity();
          } catch {}
        }
      }
    }
  }

  async sync() {
    if (!this.discord || this.state !== RpcState.Active || !this.active) return;
    try {
      const activity = build_activity(this.active.relay_info, this.real_ip, this.active.started_at);
      await this.discord.setActivity(activity);
    } catch {}
  }
}

const rpc = new Rpc();

module.exports = {
  rpc,
  Rpc,
  RpcState,
  RpcActive,
  censor_ip,
  activity_state,
  build_activity,
  RELAY_INFO,
  APP_ID
};
