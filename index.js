const express = require("express");
const { execFile, spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = 3000;

// Tool paths
const FFMPEG_DIR = String.raw`C:\Users\91750\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-9.0.1-full_build\bin`;
const YTDLP_PATH = String.raw`C:\Users\91750\AppData\Local\Programs\Python\Python311\Scripts\yt-dlp.exe`;

process.env.PATH = FFMPEG_DIR + path.delimiter + path.dirname(YTDLP_PATH) + path.delimiter + (process.env.PATH || "");

const DOWNLOADS_DIR = path.join(__dirname, "downloads");
const HISTORY_FILE = path.join(__dirname, "history.json");
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/downloads", express.static(DOWNLOADS_DIR));

// Active downloads tracker + persistent history
const activeDownloads = new Map();

function loadHistory() {
  try {
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
    for (const d of data) activeDownloads.set(d.id, d);
  } catch {}
}
function saveHistory() {
  const items = Array.from(activeDownloads.values())
    .filter(d => d.status === "completed" || d.status === "failed")
    .map(({ _process, speedHistory, ...rest }) => rest);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(items), "utf-8");
}
loadHistory();

// Quality presets
const QUALITY_PRESETS = {
  "720p": "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best[height<=720]",
  "1080p": "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080]",
  "4k": "bestvideo[height<=2160][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=2160]+bestaudio/best",
  "audio": "bestaudio",
  "best": "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best",
};

// GET /api/info
app.get("/api/info", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "URL is required" });

  try {
    const info = await getYtDlpInfo(url);
    res.json(info);
  } catch {
    try {
      const head = await axios.head(url, { timeout: 10000, maxRedirects: 5 });
      const contentType = head.headers["content-type"] || "unknown";
      const contentLength = head.headers["content-length"];
      const filename = getFilenameFromUrl(url, contentType);
      res.json({
        type: "direct",
        title: filename,
        filesize: contentLength ? parseInt(contentLength) : null,
        contentType,
        url,
        formats: [{ id: "direct", label: `Direct Download (${contentType})`, filesize: contentLength ? parseInt(contentLength) : null }],
      });
    } catch (err) {
      res.status(400).json({ error: "Could not fetch info for this URL. " + err.message });
    }
  }
});

// POST /api/download — single download
app.post("/api/download", async (req, res) => {
  const { url, format, audioOnly, title, preset } = req.body;
  if (!url) return res.status(400).json({ error: "URL is required" });

  const id = uuidv4();
  const downloadInfo = {
    id, url, title: title || "",
    status: "starting", progress: 0, speed: "", eta: "",
    filename: "", error: null,
    startedAt: Date.now(),
    speedHistory: [],
  };
  activeDownloads.set(id, downloadInfo);
  res.json({ id, message: "Download started" });

  const resolvedFormat = preset ? QUALITY_PRESETS[preset] : format;
  const isAudio = audioOnly || preset === "audio";

  if (resolvedFormat === "direct") {
    downloadDirect(id, url);
  } else {
    downloadWithYtDlp(id, url, resolvedFormat, isAudio, title);
  }
});

// POST /api/batch — batch download multiple URLs
app.post("/api/batch", async (req, res) => {
  const { urls, preset } = req.body;
  if (!urls || !Array.isArray(urls) || urls.length === 0) return res.status(400).json({ error: "urls array is required" });

  const ids = [];
  for (const entry of urls.slice(0, 20)) {
    const url = typeof entry === "string" ? entry : entry.url;
    const title = typeof entry === "string" ? "" : entry.title || "";
    if (!url) continue;

    const id = uuidv4();
    const downloadInfo = {
      id, url, title,
      status: "starting", progress: 0, speed: "", eta: "",
      filename: "", error: null,
      startedAt: Date.now(),
      speedHistory: [],
    };
    activeDownloads.set(id, downloadInfo);
    ids.push(id);

    const resolvedFormat = preset ? QUALITY_PRESETS[preset] : null;
    const isAudio = preset === "audio";
    if (resolvedFormat === "direct") {
      downloadDirect(id, url);
    } else {
      downloadWithYtDlp(id, url, resolvedFormat, isAudio, title);
    }
  }
  res.json({ ids, message: `${ids.length} downloads started` });
});

// GET /api/progress/:id
app.get("/api/progress/:id", (req, res) => {
  const info = activeDownloads.get(req.params.id);
  if (!info) return res.status(404).json({ error: "Download not found" });
  res.json(info);
});

// GET /api/downloads
app.get("/api/downloads", (req, res) => {
  const downloads = Array.from(activeDownloads.values())
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(({ _process, ...rest }) => rest);
  res.json(downloads);
});

// DELETE /api/downloads/:id
app.delete("/api/downloads/:id", (req, res) => {
  const info = activeDownloads.get(req.params.id);
  if (!info) return res.status(404).json({ error: "Download not found" });
  if (info._process) { try { info._process.kill("SIGTERM"); } catch {} }
  activeDownloads.delete(req.params.id);
  saveHistory();
  res.json({ message: "Download removed" });
});

// POST /api/open-folder/:id — open file in Explorer
app.post("/api/open-folder/:id", (req, res) => {
  const info = activeDownloads.get(req.params.id);
  if (!info || !info.filename) return res.status(404).json({ error: "File not found" });
  const filePath = path.join(DOWNLOADS_DIR, info.filename);
  spawn("explorer.exe", ["/select,", filePath], { detached: true, stdio: "ignore" });
  res.json({ message: "Opened in Explorer" });
});

// yt-dlp info — with playlist support
function getYtDlpInfo(url) {
  return new Promise((resolve, reject) => {
    const isPlaylist = url.includes("list=");
    const args = isPlaylist
      ? ["--flat-playlist", "--dump-json", "--no-download", "--no-warnings", url]
      : ["--dump-json", "--no-download", "--no-warnings", url];

    execFile(YTDLP_PATH, args, { timeout: 60000, maxBuffer: 50 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        if (isPlaylist) {
          const entries = stdout.trim().split("\n").map(l => JSON.parse(l));
          resolve({
            type: "playlist",
            title: entries[0]?.playlist_title || "Playlist",
            count: entries.length,
            entries: entries.map(e => ({ url: e.url || e.webpage_url || `https://youtube.com/watch?v=${e.id}`, title: e.title || "Unknown", duration: e.duration })),
          });
        } else {
          const data = JSON.parse(stdout);
          const formats = [];
          if (data.formats) {
            const seen = new Set();
            for (const f of data.formats) {
              if (f.vcodec && f.vcodec !== "none" && f.acodec && f.acodec !== "none") {
                const label = `${f.resolution || "unknown"} (${f.ext}) - ${formatBytes(f.filesize || f.filesize_approx)}`;
                if (!seen.has(f.format_id)) {
                  seen.add(f.format_id);
                  formats.push({ id: f.format_id, label, filesize: f.filesize || f.filesize_approx, resolution: f.resolution, ext: f.ext });
                }
              }
            }
          }
          formats.unshift({ id: "bestvideo+bestaudio/best", label: "Best Quality (Video + Audio)", filesize: null });
          formats.push({ id: "bestaudio", label: "Audio Only (MP3)", filesize: null, audioOnly: true });

          resolve({
            type: "media",
            title: data.title || "Unknown",
            thumbnail: data.thumbnail || null,
            duration: data.duration || null,
            uploader: data.uploader || null,
            filesize: data.filesize || data.filesize_approx || null,
            url,
            formats,
          });
        }
      } catch (e) { reject(e); }
    });
  });
}

// yt-dlp downloader
function downloadWithYtDlp(id, url, format, audioOnly, title) {
  const info = activeDownloads.get(id);
  const tempName = id;
  const outputTemplate = path.join(DOWNLOADS_DIR, tempName + ".%(ext)s");

  const args = ["-o", outputTemplate, "--newline", "--ffmpeg-location", FFMPEG_DIR];

  if (audioOnly) {
    args.push("-x", "--audio-format", "mp3");
  } else if (format && format !== "bestvideo+bestaudio/best") {
    args.push("-f", format, "--merge-output-format", "mp4");
  } else {
    args.push("-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best", "--merge-output-format", "mp4");
  }
  args.push(url);

  const proc = spawn(YTDLP_PATH, args);
  info._process = proc;
  info.status = "downloading";

  proc.on("error", (err) => {
    info.status = "failed";
    info.error = "yt-dlp failed to start: " + err.message;
    saveHistory();
  });

  const videoTitle = title || "";
  proc.stdout.on("data", (chunk) => {
    for (const raw of chunk.toString().split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const progressMatch = line.match(/(\d+\.?\d*)%/);
      const speedMatch = line.match(/at\s+(\S+)/);
      const etaMatch = line.match(/ETA\s+(\S+)/);
      if (progressMatch) info.progress = parseFloat(progressMatch[1]);
      if (speedMatch) {
        info.speed = speedMatch[1];
        // Track speed for sparkline
        const val = parseSpeedToBytes(speedMatch[1]);
        if (val > 0) {
          info.speedHistory = info.speedHistory || [];
          info.speedHistory.push(val);
          if (info.speedHistory.length > 30) info.speedHistory.shift();
        }
      }
      if (etaMatch) info.eta = etaMatch[1];
      if (line.includes("has already been downloaded")) info.progress = 100;
    }
  });

  proc.stderr.on("data", (chunk) => {
    for (const raw of chunk.toString().split("\n")) {
      const line = raw.trim();
      if (line.includes("ERROR")) { info.error = line; }
    }
  });

  proc.on("close", (code) => {
    delete info._process;
    if (code === 0) {
      info.status = "completed";
      info.progress = 100;
      const outputFiles = fs.readdirSync(DOWNLOADS_DIR).filter(f => f.startsWith(tempName));
      if (outputFiles.length === 1) {
        info.filename = renameToTitle(outputFiles[0], videoTitle);
      } else if (outputFiles.length > 1) {
        manualMerge(info, tempName, outputFiles, videoTitle);
        return;
      } else {
        const allFiles = fs.readdirSync(DOWNLOADS_DIR)
          .filter(f => !f.startsWith("_") && !f.startsWith("."))
          .sort((a, b) => fs.statSync(path.join(DOWNLOADS_DIR, b)).mtimeMs - fs.statSync(path.join(DOWNLOADS_DIR, a)).mtimeMs);
        if (allFiles.length > 0) info.filename = allFiles[0];
      }
      // Get filesize
      try { info.filesize = fs.statSync(path.join(DOWNLOADS_DIR, info.filename)).size; } catch {}
    } else {
      info.status = "failed";
      if (!info.error) info.error = `yt-dlp failed with exit code ${code}`;
    }
    saveHistory();
  });
}

function manualMerge(info, tempName, files, videoTitle) {
  const videoExts = [".mp4", ".webm", ".mkv"];
  const audioExts = [".m4a", ".ogg", ".opus", ".mp3"];
  const videoFile = files.find(f => videoExts.some(e => f.endsWith(e)) && !audioExts.some(e => f.endsWith(e)));
  const audioFile = files.find(f => audioExts.some(e => f.endsWith(e)) || (f.endsWith(".webm") && f !== videoFile));

  if (!videoFile || !audioFile) {
    info.filename = videoFile || files[0];
    info.status = "completed";
    saveHistory();
    return;
  }

  const videoPath = path.join(DOWNLOADS_DIR, videoFile);
  const audioPath = path.join(DOWNLOADS_DIR, audioFile);
  const outputPath = path.join(DOWNLOADS_DIR, tempName + "_merged.mp4");
  const ffmpegPath = path.join(FFMPEG_DIR, "ffmpeg.exe");

  execFile(ffmpegPath, ["-y", "-i", videoPath, "-i", audioPath, "-c", "copy", "-map", "0:v:0", "-map", "1:a:0", "-movflags", "+faststart", outputPath], { timeout: 120000 }, (err) => {
    if (err) {
      info.filename = videoFile;
      info.status = "completed";
      saveHistory();
      return;
    }
    try { fs.unlinkSync(videoPath); } catch {}
    try { fs.unlinkSync(audioPath); } catch {}
    const finalName = tempName + ".mp4";
    try { fs.renameSync(outputPath, path.join(DOWNLOADS_DIR, finalName)); } catch {}
    info.filename = renameToTitle(finalName, videoTitle);
    info.status = "completed";
    try { info.filesize = fs.statSync(path.join(DOWNLOADS_DIR, info.filename)).size; } catch {}
    saveHistory();
  });
}

async function downloadDirect(id, url) {
  const info = activeDownloads.get(id);
  info.status = "downloading";
  try {
    const response = await axios({ method: "get", url, responseType: "stream", timeout: 60000, maxRedirects: 10 });
    const contentType = response.headers["content-type"] || "";
    const totalSize = parseInt(response.headers["content-length"] || "0", 10);
    const filename = getFilenameFromUrl(url, contentType);
    info.filename = filename;
    info.filesize = totalSize || null;
    const writer = fs.createWriteStream(path.join(DOWNLOADS_DIR, filename));
    let downloaded = 0;
    const startTime = Date.now();

    response.data.on("data", (chunk) => {
      downloaded += chunk.length;
      if (totalSize > 0) info.progress = Math.round((downloaded / totalSize) * 100);
      const elapsed = (Date.now() - startTime) / 1000;
      const bps = downloaded / elapsed;
      info.speed = formatBytes(bps) + "/s";
      info.speedHistory = info.speedHistory || [];
      info.speedHistory.push(bps);
      if (info.speedHistory.length > 30) info.speedHistory.shift();
      if (totalSize > 0) info.eta = formatTime((totalSize - downloaded) / bps);
    });
    response.data.pipe(writer);
    writer.on("finish", () => { info.status = "completed"; info.progress = 100; saveHistory(); });
    writer.on("error", (err) => { info.status = "failed"; info.error = err.message; saveHistory(); });
  } catch (err) { info.status = "failed"; info.error = err.message; saveHistory(); }
}

function renameToTitle(uuidFilename, title) {
  if (!title) return uuidFilename;
  const ext = path.extname(uuidFilename);
  const safe = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!safe) return uuidFilename;
  let newName = safe + ext;
  // Handle duplicate names
  let counter = 1;
  while (fs.existsSync(path.join(DOWNLOADS_DIR, newName)) && newName !== uuidFilename) {
    newName = `${safe} (${counter++})${ext}`;
  }
  try {
    fs.renameSync(path.join(DOWNLOADS_DIR, uuidFilename), path.join(DOWNLOADS_DIR, newName));
    return newName;
  } catch { return uuidFilename; }
}

function parseSpeedToBytes(str) {
  if (!str) return 0;
  const m = str.match(/([\d.]+)\s*(B|KiB|MiB|GiB|KB|MB|GB)/i);
  if (!m) return 0;
  const val = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  const mult = { b: 1, kib: 1024, mib: 1048576, gib: 1073741824, kb: 1000, mb: 1e6, gb: 1e9 };
  return val * (mult[unit] || 1);
}

function getFilenameFromUrl(url, contentType) {
  try {
    const base = path.basename(new URL(url).pathname);
    if (base && base.includes(".")) return base;
  } catch {}
  return `download_${Date.now()}${getExtFromMime(contentType)}`;
}

function getExtFromMime(mime) {
  const map = { "application/pdf": ".pdf", "application/zip": ".zip", "image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "video/mp4": ".mp4", "audio/mpeg": ".mp3", "application/octet-stream": ".bin" };
  for (const [k, v] of Object.entries(map)) { if (mime && mime.includes(k)) return v; }
  return ".bin";
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return "Unknown";
  const s = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(1) + " " + s[i];
}

function formatTime(seconds) {
  if (!seconds || !isFinite(seconds)) return "--:--";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// JSON error handler
app.use((err, req, res, next) => {
  res.status(500).json({ error: err.message || "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`\n  NT Downloader running at http://localhost:${PORT}\n`);
  try {
    const ver = require("child_process").execFileSync(path.join(FFMPEG_DIR, "ffmpeg.exe"), ["-version"]).toString().split("\n")[0];
    console.log("  ffmpeg:", ver);
  } catch (e) { console.log("  ffmpeg NOT FOUND:", e.message); }
  console.log("  History:", activeDownloads.size, "items loaded");
});
