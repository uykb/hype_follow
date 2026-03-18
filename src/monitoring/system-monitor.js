/**
 * System Monitor - Collects Linux system metrics from /proc and /sys
 * Inspired by kula (https://github.com/c0m4r/kula)
 */
const fs = require('fs').promises;
const path = require('path');
const EventEmitter = require('events');
const logger = require('../utils/logger');

class SystemMonitor extends EventEmitter {
  constructor() {
    super();
    this.interval = null;
    this.lastCpuStats = null;
    this.lastDiskStats = {};
    this.lastNetStats = {};
    this.lastUpdate = null;
  }

  /**
   * Start collecting system metrics at specified interval
   * @param {number} intervalMs - Collection interval in milliseconds (default: 1000)
   */
  start(intervalMs = 1000) {
    if (this.interval) return;
    
    this.interval = setInterval(async () => {
      try {
        const metrics = await this.collect();
        this.emit('metrics', metrics);
      } catch (err) {
        logger.error('System monitor error:', err);
      }
    }, intervalMs);
    
    logger.info('System monitor started');
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.info('System monitor stopped');
    }
  }

  /**
   * Collect all system metrics
   */
  async collect() {
    const [cpu, memory, load, network, disk, uptime, processes] = await Promise.all([
      this.getCpu(),
      this.getMemory(),
      this.getLoad(),
      this.getNetwork(),
      this.getDisk(),
      this.getUptime(),
      this.getProcesses()
    ]);

    this.lastUpdate = Date.now();
    this.lastMetrics = {
      timestamp: this.lastUpdate,
      cpu,
      memory,
      load,
      network,
      disk,
      uptime,
      processes
    };

    return this.lastMetrics;
  }

  /**
   * Read and parse a file, return null on error
   */
  async readFileSafe(filepath) {
    try {
      return await fs.readFile(filepath, 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * Get CPU usage statistics
   */
  async getCpu() {
    const statContent = await this.readFileSafe('/proc/stat');
    if (!statContent) return null;

    const lines = statContent.split('\n');
    const cpuLine = lines[0];
    
    // Parse: cpu user nice system idle iowait irq softirq steal guest guest_nice
    const parts = cpuLine.split(/\s+/).slice(1).map(Number);
    const [user, nice, system, idle, iowait, irq, softirq, steal] = parts;

    const total = user + nice + system + idle + iowait + irq + softirq + steal;
    const active = user + nice + system + irq + softirq + steal;

    let usage = 0;
    if (this.lastCpuStats) {
      const dTotal = total - this.lastCpuStats.total;
      const dActive = active - this.lastCpuStats.active;
      usage = dTotal > 0 ? (dActive / dTotal) * 100 : 0;
    }

    this.lastCpuStats = { total, active, user, nice, system, idle, iowait, irq, softirq, steal };

    // Get CPU temperature
    const temp = await this.getCpuTemp();

    // Get number of cores
    const cores = await this.getCpuCores();

    return {
      usage: parseFloat(usage.toFixed(2)),
      user,
      system,
      idle,
      iowait,
      temp,
      cores
    };
  }

  /**
   * Get CPU temperature from thermal zones
   */
  async getCpuTemp() {
    try {
      // Try common thermal zone paths
      const thermalPaths = [
        '/sys/class/thermal/thermal_zone0/temp',
        '/sys/class/hwmon/hwmon0/temp1_input',
        '/sys/class/hwmon/hwmon1/temp1_input'
      ];

      for (const p of thermalPaths) {
        const content = await this.readFileSafe(p);
        if (content) {
          const temp = parseInt(content.trim());
          if (temp > 0) {
            // Temperature is usually in millidegrees
            return temp > 1000 ? temp / 1000 : temp;
          }
        }
      }
    } catch {}
    return null;
  }

  /**
   * Get number of CPU cores
   */
  async getCpuCores() {
    const content = await this.readFileSafe('/proc/cpuinfo');
    if (!content) return 1;
    const matches = content.match(/^processor/mg);
    return matches ? matches.length : 1;
  }

  /**
   * Get memory statistics
   */
  async getMemory() {
    const content = await this.readFileSafe('/proc/meminfo');
    if (!content) return null;

    const parseMem = (str, regex) => {
      const match = str.match(regex);
      return match ? parseInt(match[1]) : 0;
    };

    const total = parseMem(content, /MemTotal:\s+(\d+)/);
    const free = parseMem(content, /MemFree:\s+(\d+)/);
    const available = parseMem(content, /MemAvailable:\s+(\d+)/);
    const buffers = parseMem(content, /Buffers:\s+(\d+)/);
    const cached = parseMem(content, /Cached:\s+(\d+)/);
    const shmem = parseMem(content, /Shmem:\s+(\d+)/);

    const used = total - available;
    const usedPercent = total > 0 ? (used / total) * 100 : 0;

    // Swap
    const swapTotal = parseMem(content, /SwapTotal:\s+(\d+)/);
    const swapFree = parseMem(content, /SwapFree:\s+(\d+)/);
    const swapUsed = swapTotal - swapFree;
    const swapPercent = swapTotal > 0 ? (swapUsed / swapTotal) * 100 : 0;

    return {
      total: total * 1024, // Convert to bytes
      free: free * 1024,
      available: available * 1024,
      used: used * 1024,
      usedPercent: parseFloat(usedPercent.toFixed(2)),
      buffers: buffers * 1024,
      cached: cached * 1024,
      shmem: shmem * 1024,
      swap: {
        total: swapTotal * 1024,
        free: swapFree * 1024,
        used: swapUsed * 1024,
        usedPercent: parseFloat(swapPercent.toFixed(2))
      }
    };
  }

  /**
   * Get system load averages
   */
  async getLoad() {
    const content = await this.readFileSafe('/proc/loadavg');
    if (!content) return null;

    const parts = content.split(/\s+/);
    return {
      load1: parseFloat(parts[0]),
      load5: parseFloat(parts[1]),
      load15: parseFloat(parts[2])
    };
  }

  /**
   * Get network interface statistics
   */
  async getNetwork() {
    const content = await this.readFileSafe('/proc/net/dev');
    if (!content) return null;

    const lines = content.split('\n').slice(2); // Skip headers
    const interfaces = [];
    const now = Date.now();

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 17) continue;

      const name = parts[0].replace(':', '');
      if (name === 'lo') continue; // Skip loopback

      const rxBytes = parseInt(parts[1]);
      const txBytes = parseInt(parts[9]);
      const rxPackets = parseInt(parts[2]);
      const txPackets = parseInt(parts[10]);
      const rxErrors = parseInt(parts[3]);
      const txErrors = parseInt(parts[11]);
      const rxDrops = parseInt(parts[4]);
      const txDrops = parseInt(parts[12]);

      // Calculate throughput
      let rxMbps = 0, txMbps = 0;
      if (this.lastNetStats[name] && this.lastUpdate) {
        const elapsed = (now - this.lastUpdate) / 1000;
        rxMbps = ((rxBytes - this.lastNetStats[name].rxBytes) * 8 / 1000000) / elapsed;
        txMbps = ((txBytes - this.lastNetStats[name].txBytes) * 8 / 1000000) / elapsed;
      }

      this.lastNetStats[name] = { rxBytes, txBytes };

      interfaces.push({
        name,
        rxBytes,
        txBytes,
        rxMbps: parseFloat(rxMbps.toFixed(2)),
        txMbps: parseFloat(txMbps.toFixed(2)),
        rxPackets,
        txPackets,
        rxErrors,
        txErrors,
        rxDrops,
        txDrops
      });
    }

    return { interfaces };
  }

  /**
   * Get disk I/O statistics
   */
  async getDisk() {
    const content = await this.readFileSafe('/proc/diskstats');
    if (!content) return null;

    const lines = content.split('\n');
    const disks = [];
    const now = Date.now();

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 14) continue;

      const name = parts[2];
      // Skip partitions and virtual devices
      if (name.includes('loop') || name.includes('ram') || /^\d+$/.test(name)) continue;

      const reads = parseInt(parts[3]);
      const writes = parseInt(parts[7]);
      const readBytes = parseInt(parts[5]) * 512; // Sectors to bytes
      const writeBytes = parseInt(parts[9]) * 512;

      // Calculate throughput
      let readMbps = 0, writeMbps = 0;
      if (this.lastDiskStats[name] && this.lastUpdate) {
        const elapsed = (now - this.lastUpdate) / 1000;
        readMbps = ((readBytes - this.lastDiskStats[name].readBytes) * 8 / 1000000) / elapsed;
        writeMbps = ((writeBytes - this.lastDiskStats[name].writeBytes) * 8 / 1000000) / elapsed;
      }

      this.lastDiskStats[name] = { readBytes, writeBytes };

      disks.push({
        name,
        reads,
        writes,
        readBytes,
        writeBytes,
        readMbps: parseFloat(readMbps.toFixed(2)),
        writeMbps: parseFloat(writeMbps.toFixed(2))
      });
    }

    // Get filesystem usage
    const filesystems = await this.getFilesystems();

    return { disks, filesystems };
  }

  /**
   * Get filesystem usage
   */
  async getFilesystems() {
    const { exec } = require('child_process');
    const util = require('util');
    const execPromise = util.promisify(exec);

    try {
      const { stdout } = await execPromise('df -B1 --output=source,size,used,avail,target 2>/dev/null | grep "^/dev"');
      const lines = stdout.trim().split('\n');
      const filesystems = [];

      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5) {
          filesystems.push({
            device: parts[0],
            size: parseInt(parts[1]),
            used: parseInt(parts[2]),
            available: parseInt(parts[3]),
            mount: parts[4],
            usedPercent: parseFloat(((parseInt(parts[2]) / parseInt(parts[1])) * 100).toFixed(2))
          });
        }
      }

      return filesystems;
    } catch {
      return [];
    }
  }

  /**
   * Get system uptime
   */
  async getUptime() {
    const content = await this.readFileSafe('/proc/uptime');
    if (!content) return null;

    const uptime = parseFloat(content.split(/\s+/)[0]);
    return {
      seconds: uptime,
      formatted: this.formatUptime(uptime)
    };
  }

  formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    
    if (days > 0) return `${days}d ${hours}h ${mins}m`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  }

  /**
   * Get process statistics
   */
  async getProcesses() {
    const content = await this.readFileSafe('/proc/stat');
    if (!content) return null;

    const processesLine = content.split('\n').find(l => l.startsWith('procs_'));
    if (!processesLine) return null;

    const parts = processesLine.split(/\s+/);
    return {
      running: parseInt(parts[1]),
      blocked: parseInt(parts[2])
    };
  }
}

// Singleton instance
const systemMonitor = new SystemMonitor();

module.exports = systemMonitor;