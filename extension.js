/* System Monitor Pro — GNOME Shell 49/50 */
/* Individual per-chip dropdown menus with glass effect */

import GObject from 'gi://GObject';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

/* Shell blur effect for glass-like frosted background */
import Shell from 'gi://Shell';

/* ----------------------------- config ----------------------------- */

const PANEL_OPEN_INTERVAL = 900;   // ms, refresh while a popup is open
const SENSOR_RESCAN_TICKS = 60;
const TOP_PROC_CACHE_MS = 2500;    // throttle topProcesses reads
const ALL_CHIPS = ['cpu', 'ram', 'gpu', 'ssd', 'sys', 'net'];

const CHIP_META = {
    cpu: {tag: 'CPU', accent: 'accent-cpu', icon: 'cpu-symbolic',         settingsKey: 'show-cpu'},
    ram: {tag: 'RAM', accent: 'accent-ram', icon: 'memory-symbolic',      settingsKey: 'show-ram'},
    gpu: {tag: 'GPU', accent: 'accent-gpu', icon: 'gpu-symbolic',         settingsKey: 'show-gpu'},
    ssd: {tag: 'DSK', accent: 'accent-disk', icon: 'disk-symbolic',       settingsKey: 'show-disk'},
    sys: {tag: 'SYS', accent: 'accent-sys', icon: 'temperature-symbolic', settingsKey: 'show-sys'},
    net: {tag: 'NET', accent: 'accent-net', icon: 'network-symbolic',     settingsKey: 'show-net'},
};

/* ----------------------------- helpers ----------------------------- */

const decoder = new TextDecoder();

function readFile(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? decoder.decode(bytes) : null;
    } catch (_) {
        return null;
    }
}

function readTrim(path) {
    const t = readFile(path);
    return t === null ? null : t.trim();
}

function readInt(path) {
    const t = readTrim(path);
    if (t === null)
        return null;
    const n = parseInt(t, 10);
    return Number.isFinite(n) ? n : null;
}

function listDir(path) {
    const out = [];
    try {
        const dir = GLib.Dir.open(path, 0);
        let name;
        while ((name = dir.read_name()) !== null)
            out.push(name);
        dir.close();
    } catch (_) {
    }
    return out;
}

function fmtBytes(b, digits = 1) {
    if (b === null || b === undefined || Number.isNaN(b))
        return '--';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = b;
    while (v >= 1024 && i < u.length - 1) {
        v /= 1024;
        i++;
    }
    return `${i === 0 ? Math.round(v) : v.toFixed(v >= 100 ? 0 : digits)} ${u[i]}`;
}

function fmtRate(bps) {
    return `${fmtBytes(bps, 1)}/s`;
}

function num(v, d = 0, suffix = '') {
    if (v === null || v === undefined || Number.isNaN(v))
        return '--';
    return `${v.toFixed(d)}${suffix}`;
}

function runAsync(argv) {
    return new Promise(resolve => {
        let proc;
        try {
            proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (_) {
            resolve(null);
            return;
        }
        proc.communicate_utf8_async(null, null, (p, res) => {
            try {
                const [, stdout] = p.communicate_utf8_finish(res);
                resolve(p.get_successful() ? stdout : null);
            } catch (_) {
                resolve(null);
            }
        });
    });
}

/* ------------------------- sensor discovery ------------------------- */

const HWMON = '/sys/class/hwmon';

function scanSensors() {
    const all = [];
    for (const entry of listDir(HWMON)) {
        const base = `${HWMON}/${entry}`;
        const chip = readTrim(`${base}/name`);
        if (!chip)
            continue;
        for (const f of listDir(base)) {
            const m = /^temp(\d+)_input$/.exec(f);
            if (!m)
                continue;
            all.push({
                chip,
                base,
                index: parseInt(m[1], 10),
                label: readTrim(`${base}/temp${m[1]}_label`) || `temp${m[1]}`,
                path: `${base}/${f}`,
                crit: readInt(`${base}/temp${m[1]}_crit`),
            });
        }
    }
    return all;
}

function scanFans() {
    const all = [];
    for (const entry of listDir(HWMON)) {
        const base = `${HWMON}/${entry}`;
        const chip = readTrim(`${base}/name`);
        if (!chip)
            continue;
        for (const f of listDir(base)) {
            const m = /^fan(\d+)_input$/.exec(f);
            if (!m)
                continue;
            const idx = m[1];
            all.push({
                chip,
                base,
                index: parseInt(idx, 10),
                label: readTrim(`${base}/fan${idx}_label`) || `Fan ${idx}`,
                path: `${base}/${f}`,
                maxPath: GLib.file_test(`${base}/fan${idx}_max`, GLib.FileTest.EXISTS)
                    ? `${base}/fan${idx}_max` : null,
            });
        }
    }
    return all;
}

function fanRpm(fan) {
    if (!fan)
        return null;
    const v = readInt(fan.path);
    return v === null ? null : v;
}

function temp(sensor) {
    if (!sensor)
        return null;
    const v = readInt(sensor.path);
    return v === null ? null : v / 1000;
}

function chipMatches(chip, candidates) {
    return candidates.some(c => chip === c || chip.startsWith(`${c}_`));
}

function findSensor(sensors, chips, labelRe) {
    for (const s of sensors) {
        if (chipMatches(s.chip, chips) && labelRe && labelRe.test(s.label))
            return s;
    }
    for (const s of sensors) {
        if (chipMatches(s.chip, chips))
            return s;
    }
    return null;
}

function cpuTopology() {
    const map = new Map();
    const info = readFile('/proc/cpuinfo') || '';
    let cpu = null;
    for (const line of info.split('\n')) {
        const p = /^processor\s*:\s*(\d+)/.exec(line);
        if (p) {
            cpu = parseInt(p[1], 10);
            continue;
        }
        const c = /^core id\s*:\s*(\d+)/.exec(line);
        if (c && cpu !== null)
            map.set(cpu, parseInt(c[1], 10));
    }
    return map;
}

function cpuModel() {
    const info = readFile('/proc/cpuinfo') || '';
    const m = /^model name\s*:\s*(.+)$/m.exec(info);
    return m ? m[1].trim().replace(/\s+/g, ' ') : 'Processor';
}

/* --------------------------- UI primitives --------------------------- */

const Bar = GObject.registerClass(
class Bar extends St.Widget {
    _init(styleClass = 'sysmon-bar') {
        super._init({
            style_class: styleClass,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            layout_manager: new Clutter.BinLayout(),
        });
        this._fill = new St.Widget({
            style_class: 'sysmon-bar-fill',
            x_align: Clutter.ActorAlign.START,
            y_expand: true,
        });
        this.add_child(this._fill);
        this._value = 0;
        this.connect('notify::width', () => this._sync());
    }

    setValue(v) {
        this._value = Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
        for (const c of ['is-ok', 'is-warn', 'is-crit'])
            this._fill.remove_style_class_name(c);
        this._fill.add_style_class_name(
            this._value > 0.9 ? 'is-crit' : this._value > 0.7 ? 'is-warn' : 'is-ok');
        this._sync();
    }

    _sync() {
        const w = this.get_width();
        this._fill.set_width(Math.max(this._value > 0 ? 2 : 0, Math.round(w * this._value)));
    }
});

function vbox(styleClass) {
    return new St.BoxLayout({
        style_class: styleClass,
        orientation: Clutter.Orientation.VERTICAL,
        x_expand: true,
    });
}

function hbox(styleClass) {
    return new St.BoxLayout({
        style_class: styleClass,
        orientation: Clutter.Orientation.HORIZONTAL,
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
}

function label(text, styleClass) {
    return new St.Label({
        text,
        style_class: styleClass,
        y_align: Clutter.ActorAlign.CENTER,
    });
}

function metricRow(name, {nameClass = 'sysmon-row-name', valueClass = 'sysmon-row-value', withBar = true} = {}) {
    const row = hbox('sysmon-row');
    const n = label(name, nameClass);
    row.add_child(n);
    let bar = null;
    if (withBar) {
        bar = new Bar();
        row.add_child(bar);
    }
    const v = label('--', valueClass);
    row.add_child(v);
    return {actor: row, name: n, bar, value: v};
}

function sectionCard(title, subtitle) {
    const card = vbox('sysmon-card');
    const head = hbox('sysmon-card-head');
    const titles = vbox('sysmon-card-titles');
    const t = label(title, 'sysmon-card-title');
    const s = label(subtitle || '', 'sysmon-card-subtitle');
    titles.add_child(t);
    titles.add_child(s);
    head.add_child(titles);
    const big = label('--', 'sysmon-card-big');
    big.x_align = Clutter.ActorAlign.END;
    big.x_expand = true;
    head.add_child(big);
    card.add_child(head);
    const body = vbox('sysmon-card-body');
    card.add_child(body);
    return {actor: card, title: t, subtitle: s, big, body};
}

/* ----------------------------- DataStore ----------------------------- */
/* Shared data-collection layer — no UI, just reads system data.        */
/* Performance: caches expensive reads, guards against overlapping GPU. */

class DataStore {
    constructor() {
        this._tick = 0;
        this._prev = {cpu: null, cores: new Map(), net: null, netT: null, disk: null, diskT: null};
        this.gpu = {};
        this.cpu = null;
        this.mem = null;
        this.net = null;
        this.io = null;
        this.pkgTemp = null;
        this.sysTemp = null;
        this.diskTempMain = null;
        this.volumeCache = null;
        this.ipInfo = '';

        this._gpuReading = false;          // guard against overlapping async GPU reads
        this._topProcsCache = [];          // cached top-processes list
        this._topProcsTime = 0;            // monotonic ms when last read

        this.sensors = scanSensors();
        this.fans = scanFans();
        this.topology = cpuTopology();
        this.model = cpuModel();
        this._resolveSensors();
    }

    _resolveSensors() {
        const s = this.sensors;
        this._cpuPkg = findSensor(s, ['k10temp', 'zenpower', 'coretemp'], /Tctl|Tdie|Package id 0/i);
        this._coreTemps = new Map();
        for (const sensor of s) {
            const m = /^Core (\d+)$/i.exec(sensor.label);
            if (m && sensor.chip === 'coretemp')
                this._coreTemps.set(parseInt(m[1], 10), sensor);
        }
        this._ccdTemps = s.filter(x => /^Tccd\d+$/i.test(x.label));
        this._amdGpu = findSensor(s, ['amdgpu'], /edge|junction/i);
        this.dimmSensors = s.filter(x => ['spd5118', 'jc42', 'ee1004'].includes(x.chip));
        this._sysSensor = findSensor(s,
            ['acpitz', 'pch_skylake', 'pch_cannonlake', 'nct6798', 'nct6797', 'nct6793',
             'nct6687', 'it8686', 'it8792', 'thinkpad', 'asus', 'asusec', 'acer'], /SYSTIN|Systin|temp1/i);
        this._allDiskTemps = s.filter(x => ['nvme', 'drivetemp'].includes(x.chip));
    }

    refresh() {
        this._tick++;
        if (this._tick % SENSOR_RESCAN_TICKS === 0) {
            this.sensors = scanSensors();
            this.fans = scanFans();
            this._resolveSensors();
        }

        this.cpu = this._readCpu();
        this.mem = this._readMem();
        this.net = this._readNet();
        this.io = this._readDiskIO();
        this.pkgTemp = temp(this._cpuPkg);
        this.sysTemp = temp(this._sysSensor);
        this.diskTempMain = this._allDiskTemps.length
            ? temp(this._allDiskTemps.find(s => /Composite/i.test(s.label)) || this._allDiskTemps[0])
            : null;

        // GPU: async, guarded against overlap
        if ((this._tick % 2 === 1 || !this.gpu.name) && !this._gpuReading)
            this._readGpu().catch(() => {});

        // Volumes: cached, refreshed every 8 ticks
        if (this._tick % 8 === 1 || !this.volumeCache)
            this.volumeCache = this._volumes();

        // IP: infrequent
        if (this._tick % 10 === 1)
            this._fetchIp();
    }

    get rootVol() {
        if (!this.volumeCache)
            return null;
        return this.volumeCache.find(v => v.mount === '/') || this.volumeCache[0] || null;
    }

    /* ---------- CPU ---------- */

    _readCpu() {
        const stat = readFile('/proc/stat');
        if (!stat)
            return null;
        const result = {total: null, cores: []};
        for (const line of stat.split('\n')) {
            const m = /^cpu(\d*)\s+(.*)$/.exec(line);
            if (!m)
                continue;
            const f = m[2].trim().split(/\s+/).map(Number);
            const idle = f[3] + (f[4] || 0);
            const total = f.reduce((a, b) => a + b, 0);
            const id = m[1] === '' ? 'all' : parseInt(m[1], 10);
            const prev = id === 'all' ? this._prev.cpu : this._prev.cores.get(id);
            let usage = null;
            if (prev) {
                const dt = total - prev.total;
                const di = idle - prev.idle;
                if (dt > 0)
                    usage = Math.max(0, Math.min(100, (1 - di / dt) * 100));
            }
            if (id === 'all') {
                this._prev.cpu = {idle, total};
                result.total = usage;
            } else {
                this._prev.cores.set(id, {idle, total});
                result.cores[id] = usage;
            }
        }
        return result;
    }

    coreFreq(i) {
        const khz = readInt(`/sys/devices/system/cpu/cpu${i}/cpufreq/scaling_cur_freq`);
        return khz === null ? null : khz / 1e6;
    }

    coreTemp(i, numCores) {
        const coreId = this.topology.get(i);
        if (coreId !== undefined && this._coreTemps.has(coreId))
            return temp(this._coreTemps.get(coreId));
        if (this._ccdTemps.length) {
            const perCcd = Math.max(1, Math.ceil(numCores / this._ccdTemps.length));
            return temp(this._ccdTemps[Math.min(this._ccdTemps.length - 1, Math.floor(i / perCcd))]);
        }
        return temp(this._cpuPkg);
    }

    /* ---------- Memory ---------- */

    _readMem() {
        const t = readFile('/proc/meminfo');
        if (!t)
            return null;
        const get = k => {
            const m = new RegExp(`^${k}:\\s+(\\d+) kB`, 'm').exec(t);
            return m ? parseInt(m[1], 10) * 1024 : 0;
        };
        const total = get('MemTotal');
        const avail = get('MemAvailable');
        const cached = get('Cached') + get('SReclaimable') - get('Shmem');
        const buffers = get('Buffers');
        const swapTotal = get('SwapTotal');
        const swapFree = get('SwapFree');
        const used = total - avail;
        return {
            total, avail, cached, buffers, used,
            apps: Math.max(0, used - cached - buffers),
            swapTotal, swapUsed: swapTotal - swapFree,
        };
    }

    /* Throttled: caches result for TOP_PROC_CACHE_MS */
    topProcesses(limit = 5) {
        const now = GLib.get_monotonic_time() / 1000;   // ms
        if (this._topProcsCache.length && now - this._topProcsTime < TOP_PROC_CACHE_MS)
            return this._topProcsCache;

        const procs = [];
        for (const entry of listDir('/proc')) {
            if (!/^\d+$/.test(entry))
                continue;
            const statm = readTrim(`/proc/${entry}/statm`);
            if (!statm)
                continue;
            const rssPages = parseInt(statm.split(/\s+/)[1], 10);
            if (!Number.isFinite(rssPages) || rssPages <= 0)
                continue;
            const name = readTrim(`/proc/${entry}/comm`) || entry;
            procs.push({name, rss: rssPages * 4096});
        }
        procs.sort((a, b) => b.rss - a.rss);
        this._topProcsCache = procs.slice(0, limit);
        this._topProcsTime = now;
        return this._topProcsCache;
    }

    /* ---------- Network ---------- */

    _readNet() {
        const t = readFile('/proc/net/dev');
        if (!t)
            return null;
        const now = GLib.get_monotonic_time() / 1e6;
        const ifaces = [];
        let rx = 0, tx = 0;
        for (const line of t.split('\n').slice(2)) {
            const m = /^\s*([^:]+):\s*(.*)$/.exec(line);
            if (!m)
                continue;
            const name = m[1].trim();
            if (name === 'lo' || /^(veth|docker|br-|virbr|tap|tun)/.test(name))
                continue;
            const f = m[2].trim().split(/\s+/).map(Number);
            const state = readTrim(`/sys/class/net/${name}/operstate`);
            if (state !== 'up')
                continue;
            const wireless = GLib.file_test(`/sys/class/net/${name}/wireless`, GLib.FileTest.EXISTS);
            ifaces.push({name, rx: f[0], tx: f[8], wireless,
                speed: readInt(`/sys/class/net/${name}/speed`)});
            rx += f[0];
            tx += f[8];
        }
        let down = 0, up = 0;
        const perIface = new Map();
        if (this._prev.net && this._prev.netT) {
            const dt = now - this._prev.netT;
            if (dt > 0) {
                down = Math.max(0, (rx - this._prev.net.rx) / dt);
                up = Math.max(0, (tx - this._prev.net.tx) / dt);
                for (const i of ifaces) {
                    const p = this._prev.net.map.get(i.name);
                    if (p) {
                        perIface.set(i.name, {
                            down: Math.max(0, (i.rx - p.rx) / dt),
                            up: Math.max(0, (i.tx - p.tx) / dt),
                        });
                    }
                }
            }
        }
        const map = new Map(ifaces.map(i => [i.name, {rx: i.rx, tx: i.tx}]));
        this._prev.net = {rx, tx, map};
        this._prev.netT = now;
        return {down, up, totalRx: rx, totalTx: tx, ifaces, perIface};
    }

    /* ---------- Disk I/O ---------- */

    _readDiskIO() {
        const t = readFile('/proc/diskstats');
        if (!t)
            return null;
        let read = 0, write = 0;
        for (const line of t.split('\n')) {
            const f = line.trim().split(/\s+/);
            if (f.length < 10)
                continue;
            const name = f[2];
            if (!/^(nvme\d+n\d+|sd[a-z]|mmcblk\d+)$/.test(name))
                continue;
            read += parseInt(f[5], 10) * 512;
            write += parseInt(f[9], 10) * 512;
        }
        const now = GLib.get_monotonic_time() / 1e6;
        let rates = {read: 0, write: 0};
        if (this._prev.disk && this._prev.diskT) {
            const dt = now - this._prev.diskT;
            if (dt > 0) {
                rates = {
                    read: Math.max(0, (read - this._prev.disk.read) / dt),
                    write: Math.max(0, (write - this._prev.disk.write) / dt),
                };
            }
        }
        this._prev.disk = {read, write};
        this._prev.diskT = now;
        return rates;
    }

    _blockDeviceTemp(devNode) {
        const base = devNode.replace(/^\/dev\//, '').replace(/p?\d+$/, '');
        for (const dir of [`/sys/block/${base}/device`, `/sys/block/${base}/device/device`]) {
            for (const entry of listDir(dir)) {
                if (!entry.startsWith('hwmon'))
                    continue;
                const v = readInt(`${dir}/${entry}/temp1_input`);
                if (v !== null)
                    return v / 1000;
            }
        }
        for (const s of this._allDiskTemps) {
            if (/Composite/i.test(s.label))
                return temp(s);
        }
        return null;
    }

    _volumes() {
        const t = readFile('/proc/mounts');
        if (!t)
            return [];
        const seen = new Set();
        const vols = [];
        for (const line of t.split('\n')) {
            const f = line.split(/\s+/);
            if (f.length < 3)
                continue;
            const [dev, mount, fstype] = f;
            if (!dev.startsWith('/dev/'))
                continue;
            if (['squashfs', 'iso9660'].includes(fstype))
                continue;
            if (mount.startsWith('/snap') || mount.startsWith('/var/snap'))
                continue;
            if (seen.has(mount))
                continue;
            seen.add(mount);
            try {
                const info = Gio.File.new_for_path(mount)
                    .query_filesystem_info('filesystem::size,filesystem::used', null);
                const total = info.get_attribute_uint64('filesystem::size');
                const used = info.get_attribute_uint64('filesystem::used');
                if (!total)
                    continue;
                vols.push({dev, mount, fstype, total, used,
                    temp: this._blockDeviceTemp(dev)});
            } catch (_) {
            }
        }
        vols.sort((a, b) => b.total - a.total);
        return vols.slice(0, 6);
    }

    /* ---------- GPU (async, guarded) ---------- */

    async _readGpu() {
        if (this._gpuReading)
            return;
        this._gpuReading = true;
        try {
            const out = await runAsync(['nvidia-smi',
                '--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total,clocks.sm,power.draw,fan.speed',
                '--format=csv,noheader,nounits']);
            if (out && out.trim()) {
                const p = out.trim().split('\n')[0].split(',').map(s => s.trim());
                this.gpu = {
                    name: p[0],
                    util: parseFloat(p[1]),
                    temp: parseFloat(p[2]),
                    memUsed: parseFloat(p[3]) * 1024 * 1024,
                    memTotal: parseFloat(p[4]) * 1024 * 1024,
                    extra: [
                        ['Core clock', `${p[5]} MHz`],
                        ['Power draw', `${p[6]} W`],
                        ['Fan', `${p[7]} %`],
                    ],
                };
                return;
            }
            for (const entry of listDir('/sys/class/drm')) {
                if (!/^card\d+$/.test(entry))
                    continue;
                const dev = `/sys/class/drm/${entry}/device`;
                const busy = readInt(`${dev}/gpu_busy_percent`);
                if (busy === null)
                    continue;
                const vramUsed = readInt(`${dev}/mem_info_vram_used`);
                const vramTotal = readInt(`${dev}/mem_info_vram_total`);
                const clk = readTrim(`${dev}/pp_dpm_sclk`);
                const cur = clk ? (clk.split('\n').find(l => l.includes('*')) || '').trim() : '';
                this.gpu = {
                    name: `AMD ${entry}`,
                    util: busy,
                    temp: temp(this._amdGpu),
                    memUsed: vramUsed,
                    memTotal: vramTotal,
                    extra: cur ? [['Core clock', cur.replace(/^\d+:\s*/, '').replace(' *', '')]] : [],
                };
                return;
            }
            this.gpu = {
                name: this._amdGpu ? this._amdGpu.chip : 'Integrated GPU',
                util: null,
                temp: temp(this._amdGpu),
                memUsed: null,
                memTotal: null,
                extra: [['Note', 'usage counters not exposed']],
            };
        } finally {
            this._gpuReading = false;
        }
    }

    /* ---------- IP (async, fire-and-forget) ---------- */

    _fetchIp() {
        runAsync(['ip', '-4', '-o', 'addr', 'show', 'scope', 'global']).then(out => {
            if (!out)
                return;
            const ips = [...out.matchAll(/inet ([\d.]+)\/\d+/g)].map(m => m[1]);
            this.ipInfo = ips.length ? `local IP: ${ips.join(', ')}` : '';
        }).catch(() => {});
    }
}

/* ----------------------------- SysMonChip ----------------------------- */
/* Each chip is its own PanelMenu.Button with its own individual dropdown */

const SysMonChip = GObject.registerClass(
class SysMonChip extends PanelMenu.Button {
    _init(key, store, settings, iconDir) {
        super._init(0.5, `System Monitor - ${CHIP_META[key].tag}`, false);

        this._key = key;
        this._store = store;
        this._settings = settings;
        this._iconDir = iconDir;
        this._meta = CHIP_META[key];
        this._fastTimer = null;
        this._blurEffect = null;
        this._settingsIds = [];

        this.add_style_class_name('sysmon-panel-btn');

        this._buildChip();
        this._buildPopup();
        this._connectChipSettings();
    }

    /* ---------- panel chip ---------- */

    _buildChip() {
        this._chipBox = hbox(`sysmon-chip ${this._meta.accent}`);

        const dot = new St.Widget({
            style_class: 'sysmon-chip-dot',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._chipBox.add_child(dot);

        // Icon or text label — controlled by setting
        this._tagIcon = null;
        this._tagLabel = null;
        this._createTagWidget();

        this._val = label('--', 'sysmon-chip-value');
        this._chipBox.add_child(this._val);

        this.add_child(this._chipBox);
    }

    _createTagWidget() {
        if (!this._chipBox)
            return;
        const useIcons = this._settings.get_boolean('use-icons');

        // Remove old tag if any
        if (this._tagIcon) {
            this._chipBox.remove_child(this._tagIcon);
            this._tagIcon = null;
        }
        if (this._tagLabel) {
            this._chipBox.remove_child(this._tagLabel);
            this._tagLabel = null;
        }

        if (useIcons) {
            // Load icon from bundled SVG files via Gio.FileIcon for reliability
            const iconPath = `${this._iconDir}/hicolor/scalable/actions/${this._meta.icon}.svg`;
            const iconFile = Gio.File.new_for_path(iconPath);
            let gicon = null;
            if (iconFile.query_exists(null))
                gicon = new Gio.FileIcon({file: iconFile});

            if (gicon) {
                this._tagIcon = new St.Icon({
                    gicon,
                    style_class: 'sysmon-chip-icon',
                    icon_size: 14,
                    y_align: Clutter.ActorAlign.CENTER,
                });
            } else {
                // Fallback: try named icon from system theme
                this._tagIcon = new St.Icon({
                    icon_name: this._meta.icon,
                    style_class: 'sysmon-chip-icon',
                    icon_size: 14,
                    y_align: Clutter.ActorAlign.CENTER,
                });
            }
            // Insert after dot (index 1)
            this._chipBox.insert_child_at_index(this._tagIcon, 1);
        } else {
            this._tagLabel = label(this._meta.tag, 'sysmon-chip-tag');
            this._chipBox.insert_child_at_index(this._tagLabel, 1);
        }
    }

    _connectChipSettings() {
        // React to icon/text toggle
        this._settingsIds.push(
            this._settings.connect('changed::use-icons', () => this._createTagWidget())
        );
        // React to opacity/blur changes
        this._settingsIds.push(
            this._settings.connect('changed::blur-sigma', () => this._updateGlass())
        );
        this._settingsIds.push(
            this._settings.connect('changed::panel-opacity', () => this._updateGlass())
        );
    }

    /* ---------- popup ---------- */

    _buildPopup() {
        this.menu.box.add_style_class_name('sysmon-menu');

        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'sysmon-menu-item',
        });

        this._root = vbox(`sysmon-root ${this._meta.accent}`);

        // Build only this chip's section
        switch (this._key) {
            case 'cpu': this._buildCpuSection(); break;
            case 'ram': this._buildRamSection(); break;
            case 'gpu': this._buildGpuSection(); break;
            case 'ssd': this._buildDiskSection(); break;
            case 'sys': this._buildThermalSection(); break;
            case 'net': this._buildNetSection(); break;
        }

        const scroll = new St.ScrollView({
            style_class: 'sysmon-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
        });
        scroll.set_child(this._card.actor);
        this._root.add_child(scroll);

        item.add_child(this._root);
        this.menu.addMenuItem(item);

        // Glass + fast refresh when popup opens
        this.menu.connect('open-state-changed', (_m, open) => {
            if (open) {
                this._applyGlass();
                this._store.refresh();
                this.updatePanel();
                this.updateSection();
                this._startFastTimer();
            } else {
                this._removeGlass();
                this._stopFastTimer();
            }
        });
    }

    /* ---------- glass / blur effect ---------- */

    _applyGlass() {
        const opacity = this._settings.get_int('panel-opacity') / 100;
        const sigma = this._settings.get_int('blur-sigma');

        // Set semi-transparent background for glass effect
        this.menu.box.style = `background-color: rgba(22, 24, 38, ${opacity.toFixed(2)});`;

        // Add blur effect if sigma > 0
        if (sigma > 0 && !this._blurEffect) {
            try {
                this._blurEffect = new Shell.BlurEffect({
                    sigma: sigma,
                    brightness: 0.55,
                    mode: 1, // BACKGROUND — blurs what's behind the popup
                });
                this.menu.box.add_effect_with_name('sysmon-blur', this._blurEffect);
            } catch (_) {
                this._blurEffect = null;
            }
        }
    }

    _removeGlass() {
        if (this._blurEffect) {
            try {
                this.menu.box.remove_effect_by_name('sysmon-blur');
            } catch (_) {}
            this._blurEffect = null;
        }
        this.menu.box.style = '';
    }

    _updateGlass() {
        if (this.menu.isOpen) {
            this._removeGlass();
            this._applyGlass();
        }
    }

    /* ---------- fast timer ---------- */

    _startFastTimer() {
        this._stopFastTimer();
        this._fastTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            PANEL_OPEN_INTERVAL, () => {
                this._store.refresh();
                this.updatePanel();
                this.updateSection();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _stopFastTimer() {
        if (this._fastTimer) {
            GLib.source_remove(this._fastTimer);
            this._fastTimer = null;
        }
    }

    /* ---------- build sections ---------- */

    _buildCpuSection() {
        this._card = sectionCard('Processor', this._store.model);
        const summary = hbox('sysmon-stats');
        this._cpuStats = {};
        for (const [key, name] of [['temp', 'Package'], ['freq', 'Avg clock'],
            ['load', 'Load avg'], ['procs', 'Threads']]) {
            const cell = vbox('sysmon-stat');
            cell.add_child(label(name, 'sysmon-stat-name'));
            const v = label('--', 'sysmon-stat-value');
            cell.add_child(v);
            this._cpuStats[key] = v;
            summary.add_child(cell);
        }
        this._card.body.add_child(summary);

        this._card.body.add_child(label('Per-core activity', 'sysmon-subhead'));

        const columns = hbox('sysmon-columns');
        this._coreCols = [vbox('sysmon-col'), vbox('sysmon-col')];
        columns.add_child(this._coreCols[0]);
        columns.add_child(this._coreCols[1]);
        this._card.body.add_child(columns);

        this._coreRows = [];
    }

    _ensureCoreRows(count) {
        while (this._coreRows.length < count) {
            const i = this._coreRows.length;
            const row = hbox('sysmon-core');
            const name = label(`C${i}`, 'sysmon-core-name');
            const bar = new Bar('sysmon-bar sysmon-bar-core');
            const pct = label('--', 'sysmon-core-pct');
            const extra = label('--', 'sysmon-core-extra');
            row.add_child(name);
            row.add_child(bar);
            row.add_child(pct);
            row.add_child(extra);
            this._coreCols[i % 2].add_child(row);
            this._coreRows.push({row, bar, pct, extra});
        }
    }

    _buildRamSection() {
        this._card = sectionCard('Memory', 'physical + swap');
        this._ramRows = {};
        for (const [key, name] of [['used', 'In use'], ['apps', 'Apps'],
            ['cache', 'Cache'], ['buffers', 'Buffers'], ['avail', 'Available'], ['swap', 'Swap']]) {
            const r = metricRow(name);
            this._ramRows[key] = r;
            this._card.body.add_child(r.actor);
        }

        this._card.body.add_child(label('Memory modules', 'sysmon-subhead'));
        this._dimmBox = vbox('sysmon-list');
        this._card.body.add_child(this._dimmBox);

        this._card.body.add_child(label('Top consumers', 'sysmon-subhead'));
        this._procBox = vbox('sysmon-list');
        this._card.body.add_child(this._procBox);
    }

    _buildGpuSection() {
        this._card = sectionCard('Graphics', 'discrete / integrated');
        this._gpuRows = {};
        for (const [key, name] of [['util', 'Utilisation'], ['vram', 'VRAM'], ['temp', 'Temperature']]) {
            const r = metricRow(name);
            this._gpuRows[key] = r;
            this._card.body.add_child(r.actor);
        }
        this._gpuExtra = vbox('sysmon-list');
        this._card.body.add_child(this._gpuExtra);
    }

    _buildDiskSection() {
        this._card = sectionCard('Storage', 'usage, temperature, I/O');
        this._ioRow = metricRow('Disk I/O', {withBar: false});
        this._card.body.add_child(this._ioRow.actor);
        this._card.body.add_child(label('Volumes', 'sysmon-subhead'));
        this._diskBox = vbox('sysmon-list');
        this._card.body.add_child(this._diskBox);
    }

    _buildThermalSection() {
        this._card = sectionCard('Thermals', 'sensors & fans');
        this._thermBox = vbox('sysmon-list');
        this._card.body.add_child(this._thermBox);

        this._card.body.add_child(label('Fan speeds', 'sysmon-subhead'));
        this._fanBox = vbox('sysmon-list');
        this._card.body.add_child(this._fanBox);
    }

    _buildNetSection() {
        this._card = sectionCard('Network', 'live throughput');
        this._netBox = vbox('sysmon-list');
        this._card.body.add_child(this._netBox);
        this._netFoot = label('', 'sysmon-foot-text');
        this._card.body.add_child(this._netFoot);
    }

    /* ---------- update panel chip value ---------- */

    updatePanel() {
        const d = this._store;
        switch (this._key) {
            case 'cpu':
                this._val.text = `${num(d.cpu?.total, 0)}% ${num(d.pkgTemp, 0, '°')}`;
                break;
            case 'ram':
                this._val.text = d.mem ? `${num((d.mem.used / d.mem.total) * 100, 0)}%` : '--';
                break;
            case 'gpu':
                this._val.text = `${num(d.gpu.util, 0)}% ${num(d.gpu.temp, 0, '°')}`;
                break;
            case 'ssd': {
                const rv = d.rootVol;
                this._val.text = rv
                    ? `${num((rv.used / rv.total) * 100, 0)}% ${num(rv.temp ?? d.diskTempMain, 0, '°')}`
                    : '--';
                break;
            }
            case 'sys': {
                const primaryFan = d.fans.length ? fanRpm(d.fans[0]) : null;
                const fanTxt = primaryFan !== null ? ` ${primaryFan}ʀ` : '';
                this._val.text = `${num(d.sysTemp, 0, '°')}${fanTxt}`;
                break;
            }
            case 'net':
                this._val.text = d.net ? `↓${fmtRate(d.net.down)} ↑${fmtRate(d.net.up)}` : '--';
                break;
        }
    }

    /* ---------- update popup section ---------- */

    updateSection() {
        if (!this.menu.isOpen)
            return;
        const d = this._store;
        switch (this._key) {
            case 'cpu': this._updateCpu(d); break;
            case 'ram': this._updateRam(d); break;
            case 'gpu': this._updateGpu(d); break;
            case 'ssd': this._updateDisk(d); break;
            case 'sys': this._updateThermal(d); break;
            case 'net': this._updateNet(d); break;
        }
    }

    _updateCpu(d) {
        const cpu = d.cpu;
        if (!cpu)
            return;

        this._card.big.text = `${num(cpu.total, 1)}%`;
        this._cpuStats.temp.text = num(d.pkgTemp, 1, '°C');

        const freqs = [];
        for (let i = 0; i < cpu.cores.length; i++) {
            const f = d.coreFreq(i);
            if (f !== null)
                freqs.push(f);
        }
        this._cpuStats.freq.text = freqs.length
            ? `${(freqs.reduce((a, b) => a + b, 0) / freqs.length).toFixed(2)} GHz`
            : '--';

        const load = (readTrim('/proc/loadavg') || '').split(/\s+/).slice(0, 3).join('  ');
        this._cpuStats.load.text = load || '--';
        const procStat = readFile('/proc/stat') || '';
        const pm = /procs_running\s+(\d+)/.exec(procStat);
        this._cpuStats.procs.text = `${cpu.cores.length} cpus${pm ? ` • ${pm[1]} run` : ''}`;

        this._ensureCoreRows(cpu.cores.length);
        for (let i = 0; i < this._coreRows.length; i++) {
            const row = this._coreRows[i];
            const usage = cpu.cores[i];
            row.bar.setValue((usage || 0) / 100);
            row.pct.text = `${num(usage, 0)}%`;
            const f = d.coreFreq(i);
            const tC = d.coreTemp(i, this._coreRows.length);
            row.extra.text = `${f !== null ? `${f.toFixed(1)}G` : '--'} · ${num(tC, 0, '°')}`;
        }
    }

    _updateRam(d) {
        const mem = d.mem;
        if (!mem)
            return;

        this._card.big.text = `${num((mem.used / mem.total) * 100, 1)}%`;
        this._card.subtitle.text = `${fmtBytes(mem.used)} of ${fmtBytes(mem.total)} used`;

        const setRow = (key, used, total, text) => {
            const r = this._ramRows[key];
            r.bar.setValue(total ? used / total : 0);
            r.value.text = text;
        };
        setRow('used', mem.used, mem.total, `${fmtBytes(mem.used)} / ${fmtBytes(mem.total)}`);
        setRow('apps', mem.apps, mem.total, fmtBytes(mem.apps));
        setRow('cache', mem.cached, mem.total, fmtBytes(mem.cached));
        setRow('buffers', mem.buffers, mem.total, fmtBytes(mem.buffers));
        setRow('avail', mem.avail, mem.total, fmtBytes(mem.avail));
        setRow('swap', mem.swapUsed, mem.swapTotal || 1,
            mem.swapTotal ? `${fmtBytes(mem.swapUsed)} / ${fmtBytes(mem.swapTotal)}` : 'disabled');

        // DIMM temps
        this._dimmBox.destroy_all_children();
        if (d.dimmSensors.length) {
            d.dimmSensors.forEach((s, i) => {
                const row = hbox('sysmon-kv');
                row.add_child(label(`DIMM ${i + 1} · ${s.chip}`, 'sysmon-kv-key'));
                const v = label(num(temp(s), 1, ' °C'), 'sysmon-kv-value');
                v.x_expand = true;
                v.x_align = Clutter.ActorAlign.END;
                row.add_child(v);
                this._dimmBox.add_child(row);
            });
        } else {
            const row = hbox('sysmon-kv');
            row.add_child(label('No SPD temperature sensors', 'sysmon-kv-key'));
            const v = label('modprobe spd5118 / jc42', 'sysmon-kv-value');
            v.x_expand = true;
            v.x_align = Clutter.ActorAlign.END;
            row.add_child(v);
            this._dimmBox.add_child(row);
        }

        // Top processes (throttled via DataStore cache)
        const top = d.topProcesses(5);
        this._procBox.destroy_all_children();
        for (const p of top) {
            const row = hbox('sysmon-row');
            row.add_child(label(p.name.slice(0, 18), 'sysmon-row-name'));
            const bar = new Bar();
            row.add_child(bar);
            bar.setValue(p.rss / mem.total);
            const v = label(fmtBytes(p.rss), 'sysmon-row-value');
            row.add_child(v);
            this._procBox.add_child(row);
        }
    }

    _updateGpu(d) {
        this._card.subtitle.text = d.gpu.name || 'GPU';
        this._card.big.text = d.gpu.util === null || Number.isNaN(d.gpu.util)
            ? num(d.gpu.temp, 0, '°C') : `${num(d.gpu.util, 0)}%`;
        this._gpuRows.util.bar.setValue((d.gpu.util || 0) / 100);
        this._gpuRows.util.value.text = num(d.gpu.util, 0, '%');
        const vr = d.gpu.memTotal ? d.gpu.memUsed / d.gpu.memTotal : 0;
        this._gpuRows.vram.bar.setValue(vr);
        this._gpuRows.vram.value.text = d.gpu.memTotal
            ? `${fmtBytes(d.gpu.memUsed)} / ${fmtBytes(d.gpu.memTotal)}` : '--';
        this._gpuRows.temp.bar.setValue((d.gpu.temp || 0) / 100);
        this._gpuRows.temp.value.text = num(d.gpu.temp, 1, ' °C');

        this._gpuExtra.destroy_all_children();
        for (const [k, v] of d.gpu.extra || []) {
            const row = hbox('sysmon-kv');
            row.add_child(label(k, 'sysmon-kv-key'));
            const val = label(String(v), 'sysmon-kv-value');
            val.x_expand = true;
            val.x_align = Clutter.ActorAlign.END;
            row.add_child(val);
            this._gpuExtra.add_child(row);
        }
    }

    _updateDisk(d) {
        const rootVol = d.rootVol;
        this._card.big.text = rootVol ? `${num((rootVol.used / rootVol.total) * 100, 0)}%` : '--';
        this._ioRow.value.text = d.io ? `↓ ${fmtRate(d.io.read)}   ↑ ${fmtRate(d.io.write)}` : '--';
        this._diskBox.destroy_all_children();
        for (const v of d.volumeCache || []) {
            const row = hbox('sysmon-row');
            row.add_child(label(v.mount.slice(0, 14), 'sysmon-row-name'));
            const bar = new Bar();
            bar.setValue(v.used / v.total);
            row.add_child(bar);
            const val = label(
                `${fmtBytes(v.used)}/${fmtBytes(v.total)} · ${num(v.temp, 0, '°')}`,
                'sysmon-row-value');
            row.add_child(val);
            this._diskBox.add_child(row);
        }
    }

    _updateThermal(d) {
        this._card.big.text = num(d.sysTemp, 1, '°C');
        this._thermBox.destroy_all_children();
        if (!d.sensors.length) {
            const row = hbox('sysmon-kv');
            row.add_child(label('No hwmon sensors — run sudo sensors-detect', 'sysmon-kv-key'));
            this._thermBox.add_child(row);
        }
        for (const s of d.sensors) {
            const value = temp(s);
            const row = hbox('sysmon-row');
            row.add_child(label(`${s.chip}/${s.label}`.slice(0, 22), 'sysmon-row-name'));
            const bar = new Bar();
            const max = s.crit ? s.crit / 1000 : 100;
            bar.setValue((value || 0) / max);
            row.add_child(bar);
            row.add_child(label(num(value, 1, ' °C'), 'sysmon-row-value'));
            this._thermBox.add_child(row);
        }

        // Fan speeds
        this._fanBox.destroy_all_children();
        if (!d.fans.length) {
            const row = hbox('sysmon-kv');
            row.add_child(label('No fan sensors detected', 'sysmon-kv-key'));
            this._fanBox.add_child(row);
        }
        for (const f of d.fans) {
            const rpm = fanRpm(f);
            const row = hbox('sysmon-row');
            row.add_child(label(`${f.chip}/${f.label}`.slice(0, 22), 'sysmon-row-name'));
            const bar = new Bar();
            const maxRpm = f.maxPath ? (readInt(f.maxPath) || 5000) : 5000;
            bar.setValue((rpm || 0) / maxRpm);
            row.add_child(bar);
            row.add_child(label(rpm !== null ? `${rpm} RPM` : '--', 'sysmon-row-value sysmon-fan-value'));
            this._fanBox.add_child(row);
        }
    }

    _updateNet(d) {
        const net = d.net;
        if (!net)
            return;
        this._card.big.text = `↓ ${fmtRate(net.down)}`;
        this._card.subtitle.text = `↑ ${fmtRate(net.up)} • session ↓ ${fmtBytes(net.totalRx)} ↑ ${fmtBytes(net.totalTx)}`;
        this._netBox.destroy_all_children();
        for (const i of net.ifaces) {
            const rates = net.perIface.get(i.name) || {down: 0, up: 0};
            const row = hbox('sysmon-kv');
            row.add_child(label(
                `${i.name} · ${i.wireless ? 'Wi-Fi' : 'Ethernet'}${i.speed ? ` ${i.speed}M` : ''}`,
                'sysmon-kv-key'));
            const v = label(`↓ ${fmtRate(rates.down)}   ↑ ${fmtRate(rates.up)}`, 'sysmon-kv-value');
            v.x_expand = true;
            v.x_align = Clutter.ActorAlign.END;
            row.add_child(v);
            this._netBox.add_child(row);
        }
        this._netFoot.text = d.ipInfo;
    }

    /* ---------- cleanup ---------- */

    destroy() {
        this._stopFastTimer();
        this._removeGlass();
        for (const id of this._settingsIds) {
            try { this._settings.disconnect(id); } catch (_) {}
        }
        this._settingsIds = [];
        super.destroy();
    }
});

/* ----------------------------- Extension ----------------------------- */

export default class SystemMonitorProExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._store = new DataStore();
        this._chips = {};
        this._settingsConnections = [];

        this._createChips();
        this._store.refresh();
        this._updateAllPanels();
        this._startTimer();
        this._connectSettings();
    }

    _getVisibleChips() {
        return ALL_CHIPS.filter(k => this._settings.get_boolean(CHIP_META[k].settingsKey));
    }

    _createChips() {
        const position = this._settings.get_string('panel-position') || 'right';
        const visible = this._getVisibleChips();
        const iconDir = `${this.path}/icons`;

        for (let i = 0; i < visible.length; i++) {
            const key = visible[i];
            const chip = new SysMonChip(key, this._store, this._settings, iconDir);
            Main.panel.addToStatusArea(`${this.uuid}-${key}`, chip, i, position);
            this._chips[key] = chip;
        }
    }

    _destroyChips() {
        for (const key of Object.keys(this._chips)) {
            this._chips[key]?.destroy();
        }
        this._chips = {};
    }

    _rebuildChips() {
        this._destroyChips();
        this._createChips();
        this._store.refresh();
        this._updateAllPanels();
    }

    _updateAllPanels() {
        for (const chip of Object.values(this._chips))
            chip.updatePanel();
    }

    _startTimer() {
        this._clearTimer();
        const interval = this._settings.get_int('update-interval');
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, interval, () => {
            this._store.refresh();
            this._updateAllPanels();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _clearTimer() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
    }

    _connectSettings() {
        // Visibility changes → rebuild chips
        for (const key of ALL_CHIPS) {
            const id = this._settings.connect(`changed::${CHIP_META[key].settingsKey}`,
                () => this._rebuildChips());
            this._settingsConnections.push(id);
        }
        // Update interval → restart timer
        this._settingsConnections.push(
            this._settings.connect('changed::update-interval', () => this._startTimer())
        );
        // Panel position → rebuild
        this._settingsConnections.push(
            this._settings.connect('changed::panel-position', () => this._rebuildChips())
        );
    }

    disable() {
        this._clearTimer();
        for (const id of this._settingsConnections) {
            try {
                this._settings.disconnect(id);
            } catch (_) {}
        }
        this._settingsConnections = [];
        this._destroyChips();
        this._store = null;
        this._settings = null;
    }
}
