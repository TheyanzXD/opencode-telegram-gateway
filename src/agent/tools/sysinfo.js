// language: JavaScript (Node 18+ ESM), file: src/agent/tools/sysinfo.js
// Tool: host vitals for the agent — load, memory, disk, uptime, top processes.
// Read-only and cheap, so it is not dangerous and needs no approval.

import os from 'node:os';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { config } from '../../config.js';

const execFileAsync = promisify(execFile);
const schema = z.object({ section: z.enum(['summary', 'mem', 'disk', 'proc']).optional() });

function bar(used, total) {
  const pct = total ? Math.round((used / total) * 100) : 0;
  const filled = Math.round(pct / 10);
  return `[${'█'.repeat(filled)}${'░'.repeat(10 - filled)}] ${pct}%`;
}

async function diskUsage(dir) {
  try {
    const { stdout } = await execFileAsync('df', ['-h', dir]);
    const line = stdout.split('\n').filter(Boolean)[1];
    if (!line) return null;
    const [, size, used, avail, usePct, mount] = line.trim().split(/\s+/);
    return { size, used, avail, usePct, mount };
  } catch {
    return null;
  }
}

async function topProcs(limit = 8) {
  try {
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid,pcpu,pmem,rss,comm', '--sort=-pcpu']);
    return stdout
      .split('\n')
      .slice(1)
      .filter(Boolean)
      .slice(0, limit)
      .map((l) => {
        const [pid, cpu, mem, rss, ...comm] = l.trim().split(/\s+/);
        return `${pid.padStart(7)}  ${cpu.padStart(5)}%  ${mem.padStart(4)}%  ${String(Math.round(Number(rss) / 1024)).padStart(5)}MB  ${comm.join(' ')}`;
      })
      .join('\n');
  } catch {
    return null;
  }
}

export const sysinfoTool = {
  name: 'sysinfo',
  description: 'Report host vitals: CPU load, memory, disk, or top processes. Read-only.',
  isDangerous: false,
  parameters: {
    type: 'object',
    properties: { section: { type: 'string', enum: ['summary', 'mem', 'disk', 'proc'] } },
    required: [],
    additionalProperties: false,
  },
  schema,
  async execute({ section }) {
    const load = os.loadavg();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const cpuCount = os.cpus().length;

    if (section === 'mem') {
      return [
        `Memory ${bar(usedMem, totalMem)}`,
        `used  ${(usedMem / 1e9).toFixed(2)} GB`,
        `free  ${(freeMem / 1e9).toFixed(2)} GB`,
        `total ${(totalMem / 1e9).toFixed(2)} GB`,
      ].join('\n');
    }

    if (section === 'disk') {
      const d = await diskUsage(config.root);
      if (!d) return 'disk info unavailable';
      return `Disk ${bar(parseFloat(d.usePct), 100)}\nused ${d.used} of ${d.size}  avail ${d.avail}  (${d.mount})`;
    }

    if (section === 'proc') {
      const p = await topProcs();
      return p ? `Top processes (cpu/mem):\n${p}` : 'process list unavailable';
    }

    // summary
    const d = await diskUsage(config.root);
    const uptimeH = (os.uptime() / 3600).toFixed(1);
    return [
      `Host ${os.hostname()}  ${os.platform()} ${os.release()}  up ${uptimeH}h`,
      `Load ${load.map((l) => l.toFixed(2)).join(' ')}  (${cpuCount} cpu)`,
      `Mem  ${bar(usedMem, totalMem)}  ${(usedMem / 1e9).toFixed(2)}/${(totalMem / 1e9).toFixed(2)} GB`,
      d ? `Disk ${bar(parseFloat(d.usePct), 100)}  ${d.used}/${d.size}` : 'Disk —',
    ].join('\n');
  },
};
