/* ===================================================
   视频标准化处理工具 - 主逻辑
   所有处理均在浏览器端 Canvas + MediaRecorder 完成
=================================================== */

'use strict';

// ==============================
// 常量
// ==============================
const OUTPUT_FPS = 30;          // 优化4：统一 30fps
const FADE_DURATION = 0.5;      // 优化5：淡入淡出各 0.5s

// ==============================
// 状态管理
// ==============================
const state = {
  videoFile: null,
  videoURL: null,
  videoMeta: { width: 0, height: 0, duration: 0, fps: OUTPUT_FPS, size: 0, name: '' },
  selectedSpecs: new Set(),
  maskConfigs: {}, // { specId: { enabled: bool } }  fillColor 固定为 black
  frameTime: 0,
  frameFormat: 'jpeg',
  processingResults: {}, // { specId: { blob, name } }
  frameBlobURL: null,
  // 帧提取选区（相对于 cropSourceCanvas 的像素坐标）
  cropRect: null, // { x, y, w, h }
};

// ==============================
// 规格定义
// ==============================
const SPECS = {
  white360:  { id: 'white360',  label: '360×640 纯白填充',   w: 360,  h: 640,  mode: 'white'  },
  color360:  { id: 'color360',  label: '360×640 彩色全屏',   w: 360,  h: 640,  mode: 'letterbox' },
  split1500: { id: 'split1500', label: '1500×1334 左右分屏', w: 1500, h: 1334, mode: 'split'  },
};

// 蒙版参数（基底画布 750×1334）
const MASK = {
  canvasW: 750, canvasH: 1334,
  maskW: 750,   maskH: 1130,
  feather: 100,
};

// ==============================
// DOM 引用
// ==============================
const $ = id => document.getElementById(id);
const uploadZone      = $('uploadZone');
const uploadBtn       = $('uploadBtn');
const fileInput       = $('fileInput');
const uploadProgress  = $('uploadProgress');
const uploadSection   = $('uploadSection');
const workspace       = $('workspace');
const mainVideo       = $('mainVideo');
const frameSeeker     = $('frameSeeker');
const seekerTime      = $('seekerTime');
const extractFrameBtn = $('extractFrameBtn');
const framePreviewWrap= $('framePreviewWrap');
const frameCanvas     = $('frameCanvas');
const downloadFrameBtn= $('downloadFrameBtn');
const reuploadBtn     = $('reuploadBtn');
const previewTabs     = $('previewTabs');
const selectedHint    = $('selectedHint');
const previewSampleBtn= $('previewSampleBtn');
const startProcessBtn = $('startProcessBtn');
const processingModal = $('processingModal');
const taskList        = $('taskList');
const totalProgressBar= $('totalProgressBar');
const totalProgressText=$('totalProgressText');
const modalActions    = $('modalActions');
const downloadAllBtn  = $('downloadAllBtn');
const closeModalBtn   = $('closeModalBtn');
const sampleModal     = $('sampleModal');
const closeSampleModal= $('closeSampleModal');
const cancelSampleBtn = $('cancelSampleBtn');
const confirmProcessBtn=$('confirmProcessBtn');
const sampleTabs      = $('sampleTabs');
const samplePreviewArea=$('samplePreviewArea');
const toastContainer  = $('toastContainer');
// 帧提取选区 DOM
const cropContainer   = $('cropContainer');
const cropSourceCanvas= $('cropSourceCanvas');
const cropSelection   = $('cropSelection');

// ==============================
// 工具函数
// ==============================
function showToast(msg, type = 'info', duration = 3500) {
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  toastContainer.appendChild(t);
  setTimeout(() => {
    t.style.animation = 'toastOut .25s ease forwards';
    setTimeout(() => t.remove(), 300);
  }, duration);
}

function formatTime(secs) {
  const m  = Math.floor(secs / 60).toString().padStart(2, '0');
  const s  = Math.floor(secs % 60).toString().padStart(2, '0');
  const ms = Math.round((secs % 1) * 1000).toString().padStart(3, '0');
  return `${m}:${s}.${ms}`;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

function formatDuration(secs) {
  if (isNaN(secs) || !isFinite(secs)) return '--';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ==============================
// 画面合成工具
// ==============================

/**
 * 核心渲染函数：将一帧合成到 targetCanvas。
 * 全程在普通（alpha:true）的中间 canvas 完成，最终贴到 targetCanvas。
 * 这样无论 targetCanvas 是否 alpha:false 都能正确输出。
 */
function renderFrameToCanvas(src, spec, maskCfg, targetCanvas) {
  // 中间 canvas（alpha:true）负责所有合成
  const mid = document.createElement('canvas');
  mid.width  = spec.w;
  mid.height = spec.h;
  const ctx = mid.getContext('2d'); // alpha:true

  if (spec.mode === 'white') {
    // 纯白填充：整帧纯白色，不绘制视频内容，但保留蒙版效果
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, spec.w, spec.h);
    if (maskCfg && maskCfg.enabled) {
      _applyMask(ctx, spec.w, spec.h);
    }
  } else if (spec.mode === 'letterbox') {
    _drawLetterbox(ctx, src, spec.w, spec.h);
    if (maskCfg && maskCfg.enabled) {
      _applyMask(ctx, spec.w, spec.h);
    }
  } else if (spec.mode === 'color') {
    _drawLetterboxBlack(ctx, src, spec.w, spec.h);
    if (maskCfg && maskCfg.enabled) {
      _applyMask(ctx, spec.w, spec.h);
    }
  } else if (spec.mode === 'split') {
    const hw = spec.w / 2; // 750

    // 左屏：纯白填充（white mode），带蒙版
    const lMid = document.createElement('canvas');
    lMid.width = hw; lMid.height = spec.h;
    const lCtx = lMid.getContext('2d');
    lCtx.fillStyle = '#ffffff';
    lCtx.fillRect(0, 0, hw, spec.h);
    if (maskCfg && maskCfg.enabled) _applyMask(lCtx, hw, spec.h);

    // 右屏：等比缩放+白底（保持原比例，未覆盖区域填白），带蒙版
    const rMid = document.createElement('canvas');
    rMid.width = hw; rMid.height = spec.h;
    const rCtx = rMid.getContext('2d');
    _drawLetterbox(rCtx, src, hw, spec.h);
    if (maskCfg && maskCfg.enabled) _applyMask(rCtx, hw, spec.h);

    ctx.drawImage(lMid, 0, 0);
    ctx.drawImage(rMid, hw, 0);
  }

  // 把合成结果写入 targetCanvas
  const tCtx = targetCanvas.getContext('2d');
  targetCanvas.width  = spec.w;
  targetCanvas.height = spec.h;
  // 若 targetCanvas 是 alpha:false，先填白再覆盖（确保背景不透明）
  tCtx.fillStyle = '#ffffff';
  tCtx.fillRect(0, 0, spec.w, spec.h);
  tCtx.drawImage(mid, 0, 0);
}

// letterbox：等比缩放+纯白填充（内部工具，操作传入的 ctx）
function _drawLetterbox(ctx, src, canvasW, canvasH) {
  const vw = src.videoWidth || src.width;
  const vh = src.videoHeight || src.height;
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvasW, canvasH);
  if (!vw || !vh) return;
  const scale = Math.min(canvasW / vw, canvasH / vh);
  const dw = Math.round(vw * scale);
  const dh = Math.round(vh * scale);
  const dx = Math.round((canvasW - dw) / 2);
  const dy = Math.round((canvasH - dh) / 2);
  ctx.drawImage(src, dx, dy, dw, dh);
}

// letterbox（黑底）：等比缩放+黑色填充（内部工具）
function _drawLetterboxBlack(ctx, src, canvasW, canvasH) {
  const vw = src.videoWidth || src.width;
  const vh = src.videoHeight || src.height;
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, canvasW, canvasH);
  if (!vw || !vh) return;
  const scale = Math.min(canvasW / vw, canvasH / vh);
  const dw = Math.round(vw * scale);
  const dh = Math.round(vh * scale);
  const dx = Math.round((canvasW - dw) / 2);
  const dy = Math.round((canvasH - dh) / 2);
  ctx.drawImage(src, dx, dy, dw, dh);
}

// cover：等比缩放+居中裁剪（内部工具）
function _drawCover(ctx, src, canvasW, canvasH) {
  const vw = src.videoWidth || src.width;
  const vh = src.videoHeight || src.height;
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  if (!vw || !vh) return;
  const scale = Math.max(canvasW / vw, canvasH / vh);
  const sw = canvasW / scale;
  const sh = canvasH / scale;
  const sx = (vw - sw) / 2;
  const sy = (vh - sh) / 2;
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, canvasW, canvasH);
}

// 蒙版：在已有画面上叠加蒙版（内部工具，直接操作 ctx 所在 canvas）
// ctx.canvas 必须是 alpha:true 的中间 canvas
function _applyMask(ctx, w, h) {
  const maskC = buildMaskCanvas(w, h);
  // destination-in：保留原图中蒙版 alpha>0 的区域，其余变透明
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(maskC, 0, 0);
  ctx.globalCompositeOperation = 'source-over';

  // 黑底：在透明区域下方垫黑色
  const bg = document.createElement('canvas');
  bg.width = w; bg.height = h;
  const bgCtx = bg.getContext('2d');
  bgCtx.fillStyle = '#000000';
  bgCtx.fillRect(0, 0, w, h);
  bgCtx.drawImage(ctx.canvas, 0, 0);

  // 把黑底合成结果贴回 ctx（需先清空再画）
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(bg, 0, 0);
}

// 兼容旧调用（缩略图等）
function drawLetterbox(ctx, src, canvasW, canvasH) { _drawLetterbox(ctx, src, canvasW, canvasH); }
function drawCover(ctx, src, canvasW, canvasH)     { _drawCover(ctx, src, canvasW, canvasH); }

function buildMaskCanvas(w, h) {
  const scaleX = w / MASK.canvasW;
  const scaleY = h / MASK.canvasH;
  const mW = MASK.maskW * scaleX;
  const mH = MASK.maskH * scaleY;
  const mX = (w - mW) / 2;
  const mY = (h - mH) / 2;
  const feather = MASK.feather * Math.min(scaleX, scaleY);

  const mc = document.createElement('canvas');
  mc.width = w; mc.height = h;
  const mCtx = mc.getContext('2d');

  // 用单次垂直渐变覆盖完整区域（含羽化带+不透明区），避免分段绘制产生硬边
  // 渐变范围：顶部羽化起点 → 底部羽化终点
  const gradTop    = mY - feather;
  const gradBottom = mY + mH + feather;
  const grad = mCtx.createLinearGradient(0, gradTop, 0, gradBottom);
  grad.addColorStop(0,                                       'rgba(0,0,0,0)');
  grad.addColorStop((feather) / (gradBottom - gradTop),      'rgba(0,0,0,1)');
  grad.addColorStop((feather + mH) / (gradBottom - gradTop), 'rgba(0,0,0,1)');
  grad.addColorStop(1,                                       'rgba(0,0,0,0)');

  mCtx.fillStyle = grad;
  // 左右用 mX/mW 限定横向范围，保持与原逻辑一致
  mCtx.fillRect(mX, Math.max(0, gradTop), mW, Math.min(h, gradBottom) - Math.max(0, gradTop));

  return mc;
}

// 缩略图
function captureThumb(video) {
  const c = $('thumbCanvas');
  c.width = 80; c.height = 50;
  drawCover(c.getContext('2d'), video, 80, 50);
}

// ==============================
// 上传与解析
// ==============================
function setupUpload() {
  uploadBtn.addEventListener('click', () => fileInput.click());
  uploadZone.addEventListener('click', e => {
    if (!e.target.closest('.btn-upload')) fileInput.click();
  });
  uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('dragover'); });
  uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragover'));
  uploadZone.addEventListener('drop', e => {
    e.preventDefault(); uploadZone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  });
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) handleFile(fileInput.files[0]); });
  reuploadBtn.addEventListener('click', () => {
    fileInput.value = '';
    state.videoFile = null;
    if (state.videoURL) URL.revokeObjectURL(state.videoURL);
    state.videoURL = null;
    state.selectedSpecs.clear();
    state.processingResults = {};
    state.frameBlobURL = null;
    state.cropRect = null;
    workspace.style.display = 'none';
    uploadProgress.style.display = 'none';
    uploadZone.style.display = '';
    resetSpecCheckboxes();
    updateActionBar();
    fileInput.click();
  });
}

const ALLOWED_TYPES = ['video/mp4','video/quicktime','video/x-msvideo','video/webm','video/x-matroska'];
const ALLOWED_EXTS  = ['.mp4','.mov','.avi','.webm','.mkv'];
const MAX_SIZE_MB = 500;
const MAX_DURATION_MIN = 30;

function handleFile(file) {
  const ext = '.' + file.name.split('.').pop().toLowerCase();
  if (!ALLOWED_TYPES.includes(file.type) && !ALLOWED_EXTS.includes(ext)) {
    showToast('当前视频格式不支持，请上传 MP4/MOV/AVI/WebM/MKV 格式的文件', 'error', 5000); return;
  }
  if (file.size > MAX_SIZE_MB * 1024 * 1024) {
    showToast('单文件最大支持 500MB、30 分钟以内的视频，请压缩后重新上传', 'error', 5000); return;
  }
  state.videoFile = file;
  state.videoMeta.size = file.size;
  state.videoMeta.name = file.name;

  uploadZone.style.display = 'none';
  uploadProgress.style.display = '';
  $('uploadFileName').textContent = file.name;
  $('uploadPercent').textContent = '0%';
  $('uploadBar').style.width = '0%';
  $('uploadStatus').textContent = '正在解析视频...';

  simulateUploadProgress(file, () => parseVideo(file));
}

function simulateUploadProgress(file, onDone) {
  let pct = 0;
  const speed = file.size > 50 * 1024 * 1024 ? 8 : 20;
  const timer = setInterval(() => {
    pct = Math.min(pct + speed + Math.random() * 10, 90);
    $('uploadBar').style.width = pct + '%';
    $('uploadPercent').textContent = Math.round(pct) + '%';
  }, 120);
  setTimeout(() => {
    clearInterval(timer);
    $('uploadBar').style.width = '100%';
    $('uploadPercent').textContent = '100%';
    $('uploadStatus').textContent = '解析完成，准备就绪！';
    onDone();
  }, Math.min(1200, file.size / (1024 * 1024) * 100 + 600));
}

function parseVideo(file) {
  if (state.videoURL) URL.revokeObjectURL(state.videoURL);
  state.videoURL = URL.createObjectURL(file);

  const video = mainVideo;
  video.src = state.videoURL;
  video.load();

  video.addEventListener('loadedmetadata', function onMeta() {
    video.removeEventListener('loadedmetadata', onMeta);
    const dur = video.duration;
    if (dur > MAX_DURATION_MIN * 60) {
      showToast('单文件最大支持 500MB、30 分钟以内的视频，请压缩后重新上传', 'error', 5000);
      uploadProgress.style.display = 'none'; uploadZone.style.display = ''; return;
    }
    state.videoMeta.width    = video.videoWidth;
    state.videoMeta.height   = video.videoHeight;
    state.videoMeta.duration = dur;
    state.videoMeta.fps      = OUTPUT_FPS;

    // 动态设置预览窗口比例以适应视频实际宽高比（不裁剪，不拉伸）
    const previewWrap = mainVideo.closest('.video-preview-wrap');
    if (previewWrap && video.videoWidth && video.videoHeight) {
      previewWrap.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
    }

    $('videoName').textContent = state.videoMeta.name;
    $('attrRes').textContent   = `分辨率: ${video.videoWidth}×${video.videoHeight}`;
    $('attrDur').textContent   = `时长: ${formatDuration(dur)}`;
    $('attrFps').textContent   = `帧率: ${OUTPUT_FPS}fps`;
    $('attrSize').textContent  = `大小: ${formatSize(state.videoMeta.size)}`;

    frameSeeker.max = 1000;
    frameSeeker.value = 0;
    state.frameTime = 0;
    seekerTime.textContent = formatTime(0);

    video.currentTime = Math.min(1, dur * 0.1);
  }, { once: true });

  video.addEventListener('seeked', function onSeeked() {
    video.removeEventListener('seeked', onSeeked);
    captureThumb(video);
    showWorkspace();
  }, { once: true });

  video.addEventListener('error', function() {
    showToast('视频文件损坏或编码不兼容，请更换文件后重试', 'error', 5000);
    uploadProgress.style.display = 'none'; uploadZone.style.display = '';
  }, { once: true });
}

function showWorkspace() {
  uploadSection.style.display = '';
  uploadProgress.style.display = 'none';
  uploadZone.style.display = 'none';
  workspace.style.display = '';
  updateActionBar();

  mainVideo.addEventListener('timeupdate', () => {
    if (!state.videoMeta.duration) return;
    const pct = mainVideo.currentTime / state.videoMeta.duration;
    frameSeeker.value = Math.round(pct * 1000);
    seekerTime.textContent = formatTime(mainVideo.currentTime);
    state.frameTime = mainVideo.currentTime;
  });
}

function resetSpecCheckboxes() {
  ['spec1','spec2','spec3'].forEach(id => { $(id).checked = false; });
  ['mask1Row','mask2Row','mask3Row'].forEach(id => { $(id).style.display = 'none'; });
  ['mask1','mask2','mask3'].forEach(id => { $(id).checked = false; });
  previewTabs.innerHTML = '<p class="preview-placeholder">请先勾选一个输出规格查看效果预览</p>';
  framePreviewWrap.style.display = 'none';
  const emptyTip = document.getElementById('cropEmptyTip');
  if (emptyTip) emptyTip.style.display = '';
}

// ==============================
// 帧提取 + 选区裁剪（优化1）
// ==============================
// cropSourceCanvas 展示当前帧原始画面（等比缩放显示）
// 用户在上面拖拽方框，松开后裁剪为 240×240 输出到 frameCanvas

let cropDragging = false;
let cropStartX = 0, cropStartY = 0;
let cropRect = { x: 0, y: 0, w: 0, h: 0 }; // 相对于 cropSourceCanvas 的像素
// 'new' | 'move' | 'resize-tl' | 'resize-tr' | 'resize-bl' | 'resize-br'
let cropAction = 'new';
// 缩放时记录锚点（对角坐标）和拖拽起始
let cropAnchorX = 0, cropAnchorY = 0;
// 移动时记录拖拽起始与选区起点
let cropMoveStartX = 0, cropMoveStartY = 0;
let cropMoveRectX = 0, cropMoveRectY = 0;

function setupFrameExtract() {
  frameSeeker.addEventListener('input', () => {
    const t = (frameSeeker.value / 1000) * state.videoMeta.duration;
    state.frameTime = t;
    seekerTime.textContent = formatTime(t);
    mainVideo.currentTime = t;
  });

  extractFrameBtn.addEventListener('click', () => {
    if (!state.videoFile) { showToast('请先上传视频', 'warn'); return; }
    doExtractFrame();
  });

  downloadFrameBtn.addEventListener('click', () => {
    if (!state.frameBlobURL) return;
    const a = document.createElement('a');
    a.href = state.frameBlobURL;
    // 蒙版图强制 PNG（透明通道）
    a.download = `frame_${Math.round(state.frameTime * 1000)}ms_240x240.png`;
    a.click();
  });

  // ---- 选区拖拽 ----
  cropContainer.addEventListener('mousedown', onCropMouseDown);
  cropContainer.addEventListener('touchstart', onCropTouchStart, { passive: false });
  // 悬停时更新光标形状
  cropContainer.addEventListener('mousemove', onCropHover);

  // 窗口 resize 时重绘选区框（坐标不变，只需刷新 CSS 定位）
  window.addEventListener('resize', () => { if (cropRect.w) drawCropSelection(); });
}

function doExtractFrame() {
  const video = mainVideo;
  video.currentTime = state.frameTime;

  const onSeeked = () => {
    video.removeEventListener('seeked', onSeeked);

    // 把当前帧画到 cropSourceCanvas
    // canvas 内部像素尺寸 = 视频原始像素，CSS 宽度由容器控制（max-width 100%）
    const vw = video.videoWidth, vh = video.videoHeight;
    cropSourceCanvas.width  = vw;
    cropSourceCanvas.height = vh;
    const sCtx = cropSourceCanvas.getContext('2d');
    sCtx.drawImage(video, 0, 0, vw, vh);

    // 动态设置裁剪容器比例，与视频原始宽高比一致（object-fit:contain 正确显示）
    if (vw && vh) {
      cropContainer.style.aspectRatio = `${vw} / ${vh}`;
    }

    // 默认选区：正中最大正方形（视频原始像素坐标系）
    const side = Math.min(vw, vh);
    cropRect = {
      x: Math.round((vw - side) / 2),
      y: Math.round((vh - side) / 2),
      w: side, h: side,
    };
    state.cropRect = { ...cropRect };
    drawCropSelection();
    renderCropResult();

    framePreviewWrap.style.display = '';
    const emptyTip = document.getElementById('cropEmptyTip');
    if (emptyTip) emptyTip.style.display = 'none';
  };

  video.addEventListener('seeked', onSeeked, { once: true });
}

// 把当前选区裁剪为 240×240 并更新 frameCanvas
// 蒙版：185×185，圆角 25px，羽化 20px，输出四周羽化透明的 PNG
function renderCropResult() {
  if (!cropRect.w || !cropRect.h) return;

  const SIZE      = 240;
  const MASK_SIZE = 195;
  const RADIUS    = 25;
  const FEATHER   = 20; // 高斯模糊半径（px）

  // ---- 第一步：把选区画到 240×240 中间 canvas ----
  const rawCanvas = document.createElement('canvas');
  rawCanvas.width = SIZE; rawCanvas.height = SIZE;
  rawCanvas.getContext('2d').drawImage(
    cropSourceCanvas,
    cropRect.x, cropRect.y, cropRect.w, cropRect.h,
    0, 0, SIZE, SIZE
  );

  // ---- 第二步：生成带高斯羽化的蒙版 ----
  // 方案：先在超大画布上画硬边圆角矩形，再用 filter:blur 模糊，
  // 模糊后边缘 alpha 自然连续，彻底消除分割线。
  // 扩展画布尺寸避免模糊被边界截断（各边留 FEATHER*2 的余量）
  const PAD = 15;
  const blurCanvas = document.createElement('canvas');
  blurCanvas.width  = SIZE + PAD * 2;
  blurCanvas.height = SIZE + PAD * 2;
  const bCtx = blurCanvas.getContext('2d');

  // 应用高斯模糊滤镜
  bCtx.filter = `blur(${FEATHER * 0.6}px)`;

  // 在中心位置绘制硬边圆角矩形（白色不透明）
  const rx = PAD + (SIZE - MASK_SIZE) / 2;
  const ry = PAD + (SIZE - MASK_SIZE) / 2;
  bCtx.beginPath();
  bCtx.roundRect(rx, ry, MASK_SIZE, MASK_SIZE, RADIUS);
  bCtx.fillStyle = '#000';
  bCtx.fill();
  bCtx.filter = 'none';

  // 把模糊后的蒙版裁剪到标准 240×240（去掉 PAD 扩展区）
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = SIZE; maskCanvas.height = SIZE;
  maskCanvas.getContext('2d').drawImage(blurCanvas, PAD, PAD, SIZE, SIZE, 0, 0, SIZE, SIZE);

  // ---- 第三步：将图像与蒙版合成到 frameCanvas ----
  frameCanvas.width = SIZE; frameCanvas.height = SIZE;
  const ctx = frameCanvas.getContext('2d');
  ctx.clearRect(0, 0, SIZE, SIZE);

  ctx.drawImage(rawCanvas, 0, 0);
  // destination-in：用蒙版的 alpha 通道控制图像透明度，实现完美羽化
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(maskCanvas, 0, 0);
  ctx.globalCompositeOperation = 'source-over';

  // 强制输出 PNG（保留透明通道）
  frameCanvas.toBlob(blob => {
    if (state.frameBlobURL) URL.revokeObjectURL(state.frameBlobURL);
    state.frameBlobURL = URL.createObjectURL(blob);
  }, 'image/png');
}

// getCanvasPos：将鼠标/触摸的 CSS 坐标映射到 canvas 内部像素坐标
// cropSourceCanvas 用 object-fit:contain 显示，需计算 contain 偏移量
function getCanvasPos(e, canvas) {
  const rect = canvas.getBoundingClientRect();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;

  const cssW = rect.width;
  const cssH = rect.height;
  const canvasW = canvas.width;
  const canvasH = canvas.height;

  // object-fit: contain 的缩放比和偏移计算
  const scale = Math.min(cssW / canvasW, cssH / canvasH);
  const renderedW = canvasW * scale;
  const renderedH = canvasH * scale;
  const offsetX = (cssW - renderedW) / 2;  // canvas 图像左边空白 CSS px
  const offsetY = (cssH - renderedH) / 2;  // canvas 图像顶部空白 CSS px

  // 鼠标相对于容器的 CSS 坐标 - 偏移 → 再除以 scale = canvas 像素坐标
  const x = ((clientX - rect.left) - offsetX) / scale;
  const y = ((clientY - rect.top)  - offsetY) / scale;
  return { x, y };
}

// drawCropSelection：将 canvas 像素坐标的选区转换为 CSS px 后定位选区框
// 需要考虑 object-fit: contain 的偏移
function drawCropSelection() {
  const cr = cropRect;
  if (!cr.w || !cr.h) { cropSelection.style.display = 'none'; return; }

  const rect = cropSourceCanvas.getBoundingClientRect();
  const cssW = rect.width;
  const cssH = rect.height;
  const canvasW = cropSourceCanvas.width;
  const canvasH = cropSourceCanvas.height;

  // object-fit: contain 的缩放和偏移
  const scale = Math.min(cssW / canvasW, cssH / canvasH);
  const offsetX = (cssW - canvasW * scale) / 2;
  const offsetY = (cssH - canvasH * scale) / 2;

  // canvas 像素 → CSS px（加上 contain 边距偏移）
  const cssLeft   = cr.x * scale + offsetX;
  const cssTop    = cr.y * scale + offsetY;
  const cssRight  = (cr.x + cr.w) * scale + offsetX;
  const cssBottom = (cr.y + cr.h) * scale + offsetY;

  // 裁剪到容器范围内
  const visLeft   = Math.max(0, cssLeft);
  const visTop    = Math.max(0, cssTop);
  const visRight  = Math.min(cssW, cssRight);
  const visBottom = Math.min(cssH, cssBottom);

  if (visRight <= visLeft || visBottom <= visTop) {
    cropSelection.style.display = 'none'; return;
  }

  cropSelection.style.display  = '';
  cropSelection.style.left   = visLeft + 'px';
  cropSelection.style.top    = visTop + 'px';
  cropSelection.style.width  = (visRight - visLeft) + 'px';
  cropSelection.style.height = (visBottom - visTop) + 'px';
}

// ---- 命中测试：判断 canvas 像素坐标落在哪个区域 ----
// 返回 'tl'|'tr'|'bl'|'br'|'inside'|'outside'
function hitTestCrop(canvasPos) {
  const cr = cropRect;
  if (!cr.w || !cr.h) return 'outside';

  const rect = cropSourceCanvas.getBoundingClientRect();
  const cssW = rect.width, cssH = rect.height;
  // object-fit: contain
  const scale = Math.min(cssW / cropSourceCanvas.width, cssH / cropSourceCanvas.height);
  const offsetX = (cssW - cropSourceCanvas.width * scale) / 2;
  const offsetY = (cssH - cropSourceCanvas.height * scale) / 2;

  // canvas 像素 → CSS px（contain 模式加偏移）
  const toCSS = (cx, cy) => ({
    x: cx * scale + offsetX,
    y: cy * scale + offsetY,
  });

  const handleR = 10; // 手柄命中半径(CSS px)
  const handles = {
    tl: toCSS(cr.x,        cr.y),
    tr: toCSS(cr.x + cr.w, cr.y),
    bl: toCSS(cr.x,        cr.y + cr.h),
    br: toCSS(cr.x + cr.w, cr.y + cr.h),
  };

  // 鼠标 CSS 坐标
  const mx = canvasPos.x * scale + offsetX;
  const my = canvasPos.y * scale + offsetY;

  for (const [key, h] of Object.entries(handles)) {
    if (Math.abs(mx - h.x) <= handleR && Math.abs(my - h.y) <= handleR) return key;
  }

  // 框内部
  const left  = cr.x * scale + offsetX;
  const top   = cr.y * scale + offsetY;
  const right = (cr.x + cr.w) * scale + offsetX;
  const bot   = (cr.y + cr.h) * scale + offsetY;
  if (mx >= left && mx <= right && my >= top && my <= bot) return 'inside';
  return 'outside';
}

// 悬停时根据命中区域更新光标
function onCropHover(e) {
  if (cropDragging) return;
  if (!cropSourceCanvas.width || !cropRect.w) { cropContainer.style.cursor = 'crosshair'; return; }
  const pos = getCanvasPos(e, cropSourceCanvas);
  const hit = hitTestCrop(pos);
  const cursorMap = { tl: 'nwse-resize', tr: 'nesw-resize', bl: 'nesw-resize', br: 'nwse-resize', inside: 'move', outside: 'crosshair' };
  cropContainer.style.cursor = cursorMap[hit] || 'crosshair';
}

function onCropMouseDown(e) {
  if (!cropSourceCanvas.width) return;
  const pos = getCanvasPos(e, cropSourceCanvas);
  const hit = hitTestCrop(pos);

  cropDragging = true;
  if (hit === 'outside') {
    // 新建选区
    cropAction = 'new';
    cropStartX = pos.x; cropStartY = pos.y;
    cropRect = { x: pos.x, y: pos.y, w: 0, h: 0 };
  } else if (hit === 'inside') {
    // 移动
    cropAction = 'move';
    cropMoveStartX = pos.x; cropMoveStartY = pos.y;
    cropMoveRectX = cropRect.x; cropMoveRectY = cropRect.y;
  } else {
    // 缩放：以对角为锚点
    cropAction = 'resize-' + hit;
    const cr = cropRect;
    if (hit === 'tl') { cropAnchorX = cr.x + cr.w; cropAnchorY = cr.y + cr.h; }
    if (hit === 'tr') { cropAnchorX = cr.x;        cropAnchorY = cr.y + cr.h; }
    if (hit === 'bl') { cropAnchorX = cr.x + cr.w; cropAnchorY = cr.y; }
    if (hit === 'br') { cropAnchorX = cr.x;        cropAnchorY = cr.y; }
    cropStartX = pos.x; cropStartY = pos.y;
  }
  document.addEventListener('mousemove', onCropMouseMove);
  document.addEventListener('mouseup',   onCropMouseUp);
  e.preventDefault();
}

function onCropMouseMove(e) {
  if (!cropDragging) return;
  const pos = getCanvasPos(e, cropSourceCanvas);
  applyDrag(pos);
  drawCropSelection();
}

function onCropMouseUp(e) {
  cropDragging = false;
  document.removeEventListener('mousemove', onCropMouseMove);
  document.removeEventListener('mouseup',   onCropMouseUp);
  const pos = getCanvasPos(e, cropSourceCanvas);
  applyDrag(pos);
  drawCropSelection();
  if (cropRect.w > 4 && cropRect.h > 4) {
    state.cropRect = { ...cropRect };
    renderCropResult();
  }
}

function onCropTouchStart(e) {
  e.preventDefault();
  if (!cropSourceCanvas.width) return;
  const pos = getCanvasPos(e, cropSourceCanvas);
  const hit = hitTestCrop(pos);

  cropDragging = true;
  if (hit === 'outside') {
    cropAction = 'new';
    cropStartX = pos.x; cropStartY = pos.y;
    cropRect = { x: pos.x, y: pos.y, w: 0, h: 0 };
  } else if (hit === 'inside') {
    cropAction = 'move';
    cropMoveStartX = pos.x; cropMoveStartY = pos.y;
    cropMoveRectX = cropRect.x; cropMoveRectY = cropRect.y;
  } else {
    cropAction = 'resize-' + hit;
    const cr = cropRect;
    if (hit === 'tl') { cropAnchorX = cr.x + cr.w; cropAnchorY = cr.y + cr.h; }
    if (hit === 'tr') { cropAnchorX = cr.x;        cropAnchorY = cr.y + cr.h; }
    if (hit === 'bl') { cropAnchorX = cr.x + cr.w; cropAnchorY = cr.y; }
    if (hit === 'br') { cropAnchorX = cr.x;        cropAnchorY = cr.y; }
    cropStartX = pos.x; cropStartY = pos.y;
  }
  document.addEventListener('touchmove', onCropTouchMove, { passive: false });
  document.addEventListener('touchend',  onCropTouchEnd);
}

function onCropTouchMove(e) {
  e.preventDefault();
  if (!cropDragging) return;
  const pos = getCanvasPos(e, cropSourceCanvas);
  applyDrag(pos);
  drawCropSelection();
}

function onCropTouchEnd(_e) {
  cropDragging = false;
  document.removeEventListener('touchmove', onCropTouchMove);
  document.removeEventListener('touchend',  onCropTouchEnd);
  if (cropRect.w > 4 && cropRect.h > 4) {
    state.cropRect = { ...cropRect };
    renderCropResult();
  }
}

// applyDrag：根据 cropAction 更新 cropRect
function applyDrag(pos) {
  const cw = cropSourceCanvas.width;
  const ch = cropSourceCanvas.height;

  if (cropAction === 'new') {
    // 新建选区：强制正方形
    const dx = pos.x - cropStartX;
    const dy = pos.y - cropStartY;
    const side = Math.min(Math.abs(dx), Math.abs(dy));
    const x = dx >= 0 ? cropStartX : cropStartX - side;
    const y = dy >= 0 ? cropStartY : cropStartY - side;
    const bx = Math.max(0, Math.min(x, cw - side));
    const by = Math.max(0, Math.min(y, ch - side));
    const bs = Math.min(side, cw - bx, ch - by);
    cropRect = { x: bx, y: by, w: bs, h: bs };
  } else if (cropAction === 'move') {
    const dx = pos.x - cropMoveStartX;
    const dy = pos.y - cropMoveStartY;
    const nx = Math.max(0, Math.min(cropMoveRectX + dx, cw - cropRect.w));
    const ny = Math.max(0, Math.min(cropMoveRectY + dy, ch - cropRect.h));
    cropRect = { ...cropRect, x: nx, y: ny };
  } else if (cropAction.startsWith('resize-')) {
    // 以 cropAnchor 为锚点，拖拽当前角
    const ax = cropAnchorX, ay = cropAnchorY;
    const dx = pos.x - ax;
    const dy = pos.y - ay;
    const side = Math.min(Math.abs(dx), Math.abs(dy));
    const x = dx >= 0 ? ax : ax - side;
    const y = dy >= 0 ? ay : ay - side;
    const bx = Math.max(0, Math.min(x, cw - side));
    const by = Math.max(0, Math.min(y, ch - side));
    const bs = Math.min(side, cw - bx, ch - by);
    cropRect = { x: bx, y: by, w: bs, h: bs };
  }
}

// ==============================
// 规格勾选与蒙版配置
// ==============================
const specCheckMap = {
  spec1: { specId: 'white360',  maskRowId: 'mask1Row', maskId: 'mask1' },
  spec2: { specId: 'color360',  maskRowId: 'mask2Row', maskId: 'mask2' },
  spec3: { specId: 'split1500', maskRowId: 'mask3Row', maskId: 'mask3' },
};

function setupSpecCheckboxes() {
  Object.entries(specCheckMap).forEach(([checkId, cfg]) => {
    const checkbox = $(checkId);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        state.selectedSpecs.add(cfg.specId);
        $(cfg.maskRowId).style.display = '';
        // 默认开启蒙版（优化2）
        if (!state.maskConfigs[cfg.specId]) {
          state.maskConfigs[cfg.specId] = { enabled: true };
        } else {
          state.maskConfigs[cfg.specId].enabled = true;
        }
        $(cfg.maskId).checked = true;
      } else {
        state.selectedSpecs.delete(cfg.specId);
        $(cfg.maskRowId).style.display = 'none';
        $(cfg.maskId).checked = false;
        if (state.maskConfigs[cfg.specId]) {
          state.maskConfigs[cfg.specId].enabled = false;
        }
      }
      updateActionBar();
      schedulePreviewRefresh();
    });

    const maskChk = $(cfg.maskId);
    maskChk.addEventListener('change', () => {
      if (!state.maskConfigs[cfg.specId]) state.maskConfigs[cfg.specId] = { enabled: false };
      state.maskConfigs[cfg.specId].enabled = maskChk.checked;
      schedulePreviewRefresh();
    });
  });
}

// ==============================
// 预览区更新
// ==============================
let previewTimer = null;
let previewRafId = null; // 预览动画帧 ID

function schedulePreviewRefresh() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(updatePreview, 300);
}

function updatePreview() {
  // 停止旧的预览动画
  if (previewRafId) { cancelAnimationFrame(previewRafId); previewRafId = null; }

  if (state.selectedSpecs.size === 0) {
    previewTabs.innerHTML = '<p class="preview-placeholder">请先勾选一个输出规格查看效果预览</p>';
    return;
  }
  const specs = [...state.selectedSpecs].map(id => SPECS[id]);

  let tabsHTML = '<div class="preview-tabs-nav">';
  specs.forEach((spec, i) => {
    tabsHTML += `<button class="preview-tab-btn${i===0?' active':''}" data-tab="${spec.id}">${spec.label}</button>`;
  });
  tabsHTML += '</div>';

  let canvasesHTML = '';
  specs.forEach((spec, i) => {
    canvasesHTML += `
      <div class="preview-canvas-area" id="prevArea_${spec.id}" style="${i===0?'':'display:none'}">
        <div class="preview-canvas-wrap">
          <canvas id="prevCanvas_${spec.id}" class="preview-canvas"></canvas>
          <span class="preview-canvas-label">${spec.w}×${spec.h} · ${spec.label}</span>
        </div>
      </div>`;
  });

  previewTabs.innerHTML = tabsHTML + canvasesHTML;

  previewTabs.querySelectorAll('.preview-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      previewTabs.querySelectorAll('.preview-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      specs.forEach(s => {
        const area = $(`prevArea_${s.id}`);
        if (area) area.style.display = s.id === btn.dataset.tab ? '' : 'none';
      });
    });
  });

  // 初始化各预览 canvas 尺寸
  specs.forEach(spec => {
    const canvas = $(`prevCanvas_${spec.id}`);
    if (!canvas) return;
    const maxW = 300, maxH = 240;
    const scale = Math.min(maxW / spec.w, maxH / spec.h, 1);
    canvas.width  = Math.round(spec.w * scale);
    canvas.height = Math.round(spec.h * scale);
  });

  // 启动实时预览动画（跟随 mainVideo 播放）
  startPreviewAnimation(specs);
}

function startPreviewAnimation(specs) {
  // 每个规格共用一个全尺寸中间 canvas
  const tmpMap = {};
  specs.forEach(spec => {
    const c = document.createElement('canvas');
    c.width = spec.w; c.height = spec.h;
    tmpMap[spec.id] = c;
  });

  let lastTime = -1;
  let lastRenderMs = 0;

  function frame() {
    previewRafId = requestAnimationFrame(frame);
    if (!mainVideo.videoWidth) return;

    const ct = mainVideo.currentTime;
    const now = performance.now();
    const videoChanged = Math.abs(ct - lastTime) > 0.001;
    // 视频播放时跟随每帧更新；静止时每 150ms 刷新一次（处理 seek 后的首帧）
    if (!videoChanged && now - lastRenderMs < 150) return;
    lastTime = ct;
    lastRenderMs = now;

    specs.forEach(spec => {
      const canvas = $(`prevCanvas_${spec.id}`);
      if (!canvas) return;
      // 只渲染当前可见的 tab
      const area = $(`prevArea_${spec.id}`);
      if (area && area.style.display === 'none') return;

      const maskCfg = state.maskConfigs[spec.id];
      const tmp = tmpMap[spec.id];
      renderFrameToCanvas(mainVideo, spec, maskCfg, tmp);
      canvas.getContext('2d').drawImage(tmp, 0, 0, canvas.width, canvas.height);
    });
  }

  previewRafId = requestAnimationFrame(frame);
}

// ==============================
// 操作栏更新
// ==============================
function updateActionBar() {
  const count = state.selectedSpecs.size;
  if (count === 0) {
    selectedHint.textContent = '未选择任何规格';
    previewSampleBtn.disabled = true;
    startProcessBtn.disabled = true;
  } else {
    const names = [...state.selectedSpecs].map(id => SPECS[id].label).join('、');
    selectedHint.textContent = `已选择 ${count} 个规格：${names}`;
    previewSampleBtn.disabled = false;
    startProcessBtn.disabled = false;
  }
}

$('refreshPreviewBtn').addEventListener('click', () => updatePreview());

// ==============================
// 样片预览弹窗
// ==============================
function setupSampleModal() {
  previewSampleBtn.addEventListener('click', openSampleModal);
  closeSampleModal.addEventListener('click', () => sampleModal.style.display = 'none');
  cancelSampleBtn.addEventListener('click', () => sampleModal.style.display = 'none');
  confirmProcessBtn.addEventListener('click', () => { sampleModal.style.display = 'none'; startProcessing(); });
  sampleModal.addEventListener('click', e => { if (e.target === sampleModal) sampleModal.style.display = 'none'; });
}

function openSampleModal() {
  if (state.selectedSpecs.size === 0) return;
  const specs = [...state.selectedSpecs].map(id => SPECS[id]);

  sampleTabs.innerHTML = specs.map((s, i) =>
    `<button class="preview-tab-btn${i===0?' active':''}" data-stab="${s.id}">${s.label}</button>`
  ).join('');

  samplePreviewArea.innerHTML = specs.map((s, i) =>
    `<div class="sample-canvas-wrap" id="smpWrap_${s.id}" style="${i===0?'':'display:none'}">
      <canvas id="smpCanvas_${s.id}" class="sample-canvas"></canvas>
      <span class="sample-canvas-label">${s.w}×${s.h} · ${s.label}</span>
    </div>`
  ).join('');

  sampleTabs.querySelectorAll('.preview-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      sampleTabs.querySelectorAll('.preview-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      specs.forEach(s => {
        const w = $(`smpWrap_${s.id}`);
        if (w) w.style.display = s.id === btn.dataset.stab ? '' : 'none';
      });
    });
  });

  specs.forEach(spec => {
    const canvas = $(`smpCanvas_${spec.id}`);
    if (!canvas || !mainVideo.videoWidth) return;
    const maskCfg = state.maskConfigs[spec.id];
    const scale = Math.min(380 / spec.w, 260 / spec.h, 1);
    canvas.width  = Math.round(spec.w * scale);
    canvas.height = Math.round(spec.h * scale);
    const tmpC = document.createElement('canvas');
    tmpC.width = spec.w; tmpC.height = spec.h;
    renderFrameToCanvas(mainVideo, spec, maskCfg, tmpC);
    canvas.getContext('2d').drawImage(tmpC, 0, 0, canvas.width, canvas.height);
  });

  sampleModal.style.display = 'flex';
}

// ==============================
// 开始处理
// ==============================
startProcessBtn.addEventListener('click', () => startProcessing());

async function startProcessing() {
  const specs = [...state.selectedSpecs].map(id => SPECS[id]);
  if (specs.length === 0) return;
  state.processingResults = {};

  const tasks = specs.map(spec => ({
    spec,
    maskCfg: state.maskConfigs[spec.id] || { enabled: false },
  }));

  buildTaskListUI(tasks);
  processingModal.style.display = 'flex';
  modalActions.style.display = 'none';
  $('processingSubtitle').textContent = `正在处理 ${tasks.length} 个规格，请稍候...`;

  let totalCompleted = 0;

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    updateTaskStatus(task.spec.id, 'processing', 0);
    try {
      const blob = await processVideoSpec(task.spec, task.maskCfg, pct => {
        updateTaskStatus(task.spec.id, 'processing', pct);
        setTotalProgress(Math.round(((totalCompleted + pct / 100) / tasks.length) * 100));
      });
      const specNameMap = {
        white360:  '360x640黑白',
        color360:  '360x640彩色',
        split1500: '1500x1334',
      };
      state.processingResults[task.spec.id] = {
        blob,
        name: `${specNameMap[task.spec.id] || task.spec.id}${blob.type.includes('mp4') ? '.mp4' : '.webm'}`,
      };
      updateTaskStatus(task.spec.id, 'done', 100);
      totalCompleted++;
      setTotalProgress(Math.round((totalCompleted / tasks.length) * 100));
    } catch (e) {
      updateTaskStatus(task.spec.id, 'failed', 0);
      console.error('处理失败', task.spec.id, e);
      totalCompleted++;
    }
  }

  $('processingSubtitle').textContent = '全部处理完成！';
  modalActions.style.display = 'flex';
}

function buildTaskListUI(tasks) {
  taskList.innerHTML = tasks.map(t => `
    <div class="task-item" id="taskItem_${t.spec.id}">
      <div class="task-header">
        <span class="task-name">${t.spec.label}（${t.spec.w}×${t.spec.h}）</span>
        <span class="task-status status-pending" id="taskStatus_${t.spec.id}">等待中</span>
      </div>
      <div class="task-progress-wrap">
        <div class="task-progress" id="taskProg_${t.spec.id}"></div>
      </div>
    </div>
  `).join('');
  setTotalProgress(0);
}

function updateTaskStatus(specId, status, pct) {
  const statusEl = $(`taskStatus_${specId}`);
  const progEl   = $(`taskProg_${specId}`);
  if (!statusEl || !progEl) return;
  const labels = { pending: '等待中', processing: '处理中', done: '完成', failed: '失败' };
  statusEl.textContent = labels[status] || status;
  statusEl.className = `task-status status-${status}`;
  if (status === 'processing') { progEl.style.width = pct + '%'; progEl.className = 'task-progress'; }
  else if (status === 'done')  { progEl.style.width = '100%';    progEl.className = 'task-progress done'; }
  else if (status === 'failed'){ progEl.className = 'task-progress failed'; }
}

function setTotalProgress(pct) {
  totalProgressBar.style.width = pct + '%';
  totalProgressText.textContent = pct + '%';
}

closeModalBtn.addEventListener('click', () => processingModal.style.display = 'none');
processingModal.addEventListener('click', e => { if (e.target === processingModal) processingModal.style.display = 'none'; });

// ==============================
// 视频输出：优先 WebCodecs (H.264 MP4)，不支持时回退到 MediaRecorder (WebM)
// ==============================

let mp4MuxerModule = null;
async function loadMp4Muxer() {
  if (mp4MuxerModule) return mp4MuxerModule;
  mp4MuxerModule = await import('https://esm.sh/mp4-muxer@5');
  return mp4MuxerModule;
}

// 检测 WebCodecs 是否可用
function hasWebCodecs() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
}

async function processVideoSpec(spec, maskCfg, onProgress) {
  // 所有规格统一使用 WebCodecs 逐帧编码方案（时间戳精确，无慢动作问题）
  // WebCodecs 不可用时才回退到 captureStream 保底方案
  if (hasWebCodecs()) {
    try {
      return await _encodeWithWebCodecs(spec, maskCfg, onProgress);
    } catch (e) {
      console.error('WebCodecs 处理失败:', e);
      showToast(`编码失败，使用备用方案处理 ${spec.w}×${spec.h}...`, 'warn', 3000);
      return _encodeWithCaptureStream(spec, maskCfg, onProgress);
    }
  } else {
    return _encodeWithCaptureStream(spec, maskCfg, onProgress);
  }
}

// ---- 方案A：WebCodecs + mp4-muxer → 真正的 H.264 MP4（所有规格统一使用此方案）----
// WebCodecs 编码核心（逐帧 seek，时间戳精确控制，无慢动作问题）
async function _encodeWithWebCodecs(spec, maskCfg, onProgress) {
  const { Muxer, ArrayBufferTarget } = await loadMp4Muxer();

  const video = document.createElement('video');
  video.src = state.videoURL;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';

  await new Promise((res, rej) => {
    video.addEventListener('loadedmetadata', res, { once: true });
    video.addEventListener('error', rej, { once: true });
    video.load();
  });

  const duration = video.duration;
  const fps = OUTPUT_FPS;
  const totalFrames = Math.ceil(duration * fps);
  const outW = spec.w % 2 === 0 ? spec.w : spec.w + 1;
  const outH = spec.h % 2 === 0 ? spec.h : spec.h + 1;

  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    video: { codec: 'avc', width: outW, height: outH },
    fastStart: 'in-memory',
  });

  // 按优先级尝试多个 codec 配置，找到第一个浏览器真正支持的
  const pixels = outW * outH;
  const bitrate = Math.min(12_000_000, Math.max(2_000_000, pixels * fps * 0.07));
  // 大分辨率优先用 High Profile L4.0（avc1.640028），小分辨率用 Baseline L3.0（avc1.42E01E）
  // avc1.42E01E = Baseline L3.0，H.264 标准限制约 576p；超出需要 L4.0+
  const codecCandidates = pixels > 720 * 576
    ? ['avc1.640028', 'avc1.4D0028', 'avc1.42001E']
    : ['avc1.42E01E', 'avc1.4D001E', 'avc1.640028'];

  let encoderConfig = null;
  for (const codec of codecCandidates) {
    const cfg = { codec, width: outW, height: outH, bitrate, framerate: fps, latencyMode: 'quality' };
    try {
      // 先用 isConfigSupported 检查（若API存在）
      if (VideoEncoder.isConfigSupported) {
        const support = await VideoEncoder.isConfigSupported(cfg);
        if (!support.supported) continue;
      }
      // 真正尝试 configure：部分浏览器 isConfigSupported 返回 true 但 configure 仍失败
      const testEncoder = new VideoEncoder({ output: () => {}, error: () => {} });
      testEncoder.configure(cfg);
      testEncoder.close();
      encoderConfig = cfg;
      break;
    } catch (_) { /* 继续尝试下一个 */ }
  }
  if (!encoderConfig) {
    throw new Error(`VideoEncoder 不支持 ${outW}×${outH} 的任何 AVC 配置`);
  }
  console.log(`[编码] ${spec.w}×${spec.h} 使用 codec: ${encoderConfig.codec}`);

  let encoderError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (e) => { encoderError = e; },
  });
  encoder.configure(encoderConfig);

  const tmpCanvas = document.createElement('canvas');
  tmpCanvas.width  = outW;
  tmpCanvas.height = outH;

  const fadeDur = FADE_DURATION; // 0.5s
  // 背压阈值：队列积压超过此值时等待，防止大分辨率内存溢出/编码失速
  const MAX_QUEUE = 10;

  for (let i = 0; i < totalFrames; i++) {
    if (encoderError) throw encoderError;

    // 背压控制：等待编码器队列消化
    while (encoder.encodeQueueSize > MAX_QUEUE) {
      await new Promise(r => setTimeout(r, 5));
    }

    // seek 时间：不超过 duration
    const ct = Math.min(i / fps, duration - 0.001);
    await seekVideoTo(video, ct);

    renderFrameToCanvas(video, spec, maskCfg, tmpCanvas);

    // 淡入淡出：以帧索引计算，避免浮点误差
    const frameAlpha = (() => {
      const t = i / fps;
      if (t < fadeDur) return t / fadeDur;
      const remaining = duration - t;
      if (remaining < fadeDur) return Math.max(0, remaining / fadeDur);
      return 1;
    })();

    if (frameAlpha < 1) {
      const ctx2 = tmpCanvas.getContext('2d');
      ctx2.fillStyle = `rgba(0,0,0,${(1 - frameAlpha).toFixed(4)})`;
      ctx2.fillRect(0, 0, outW, outH);
    }

    const timestamp = Math.round((i / fps) * 1_000_000);
    const bitmap = await createImageBitmap(tmpCanvas);
    const frame = new VideoFrame(bitmap, { timestamp, duration: Math.round(1_000_000 / fps) });
    bitmap.close();

    encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
    frame.close();

    onProgress(Math.round(((i + 1) / totalFrames) * 95));
    if (i % 5 === 0) await yieldToMain();
  }

  await encoder.flush();
  encoder.close();
  muxer.finalize();
  onProgress(100);

  return new Blob([target.buffer], { type: 'video/mp4' });
}

// 最终保底方案：captureStream（帧率由浏览器控制，不保证精确）
async function _encodeWithCaptureStream(spec, maskCfg, onProgress) {
  const video = document.createElement('video');
  video.src = state.videoURL;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';

  await new Promise((res, rej) => {
    video.addEventListener('loadedmetadata', res, { once: true });
    video.addEventListener('error', rej, { once: true });
    video.load();
  });

  const duration = video.duration;
  const fps = OUTPUT_FPS;
  const totalFrames = Math.ceil(duration * fps);
  const fadeDur = FADE_DURATION;

  const outCanvas = document.createElement('canvas');
  outCanvas.width  = spec.w;
  outCanvas.height = spec.h;
  const outCtx = outCanvas.getContext('2d');

  const tmpCanvas = document.createElement('canvas');
  tmpCanvas.width  = spec.w;
  tmpCanvas.height = spec.h;

  const stream = outCanvas.captureStream(fps);
  const mimeType = getSupportedMimeType();
  let recorder;
  try {
    recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 6_000_000 } : {});
  } catch(_) {
    recorder = new MediaRecorder(stream);
  }

  const chunks = [];
  recorder.ondataavailable = e => { if (e.data && e.data.size > 0) chunks.push(e.data); };
  const recordingDone = new Promise((resolve, reject) => {
    recorder.onstop  = () => resolve(new Blob(chunks, { type: recorder.mimeType || 'video/webm' }));
    recorder.onerror = reject;
  });

  recorder.start(100);

  for (let i = 0; i < totalFrames; i++) {
    const ct = Math.min(i / fps, duration - 0.001);
    await seekVideoTo(video, ct);

    renderFrameToCanvas(video, spec, maskCfg, tmpCanvas);

    const frameAlpha = (() => {
      const t = i / fps;
      if (t < fadeDur) return t / fadeDur;
      const remaining = duration - t;
      if (remaining < fadeDur) return Math.max(0, remaining / fadeDur);
      return 1;
    })();

    if (frameAlpha < 1) {
      const tmpCtx = tmpCanvas.getContext('2d');
      tmpCtx.fillStyle = `rgba(0,0,0,${(1 - frameAlpha).toFixed(4)})`;
      tmpCtx.fillRect(0, 0, spec.w, spec.h);
    }

    outCtx.clearRect(0, 0, spec.w, spec.h);
    outCtx.drawImage(tmpCanvas, 0, 0);

    onProgress(Math.round(((i + 1) / totalFrames) * 95));
    await yieldToMain();
  }

  recorder.stop();
  onProgress(100);
  return recordingDone;
}

function getSupportedMimeType() {
  const types = [
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  for (const t of types) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return '';
}

function yieldToMain() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// 计算当前时间点的画面不透明度（淡入淡出）
function getFadeAlpha(currentTime, duration) {
  if (currentTime < FADE_DURATION) return Math.max(0, currentTime / FADE_DURATION);
  if (currentTime > duration - FADE_DURATION) return Math.max(0, (duration - currentTime) / FADE_DURATION);
  return 1;
}

function seekVideoTo(video, time) {
  return new Promise(res => {
    if (Math.abs(video.currentTime - time) < 0.001) { res(); return; }
    video.addEventListener('seeked', res, { once: true });
    video.currentTime = time;
  });
}

// ==============================
// 下载
// ==============================
downloadAllBtn.addEventListener('click', async () => {
  const entries = Object.values(state.processingResults);
  const hasFrame = !!state.frameBlobURL;

  if (entries.length === 0 && !hasFrame) { showToast('没有可下载的文件', 'warn'); return; }

  // 只有一个视频且无帧图片 → 直接下载
  if (entries.length === 1 && !hasFrame) { downloadBlob(entries[0].blob, entries[0].name); return; }

  // 只有帧图片没有视频
  if (entries.length === 0 && hasFrame) {
    const ext = state.frameFormat === 'png' ? 'png' : 'jpg';
    downloadBlob(await fetchBlobFromURL(state.frameBlobURL), `240x240.${ext}`);
    return;
  }

  downloadAllBtn.disabled = true;
  downloadAllBtn.textContent = '打包中...';
  try {
    await loadJSZip();
    const zip = new window['JSZip']();
    entries.forEach(({ blob, name }) => zip.file(name, blob));

    // 将帧提取图片加入 ZIP（优化5，蒙版图强制 PNG）
    if (hasFrame) {
      const frameBlob = await fetchBlobFromURL(state.frameBlobURL);
      zip.file(`240x240.png`, frameBlob);
    }

    const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }, meta => {
      downloadAllBtn.textContent = `打包中 ${Math.round(meta.percent)}%...`;
    });
    downloadBlob(zipBlob, '视频标准化处理结果.zip');
  } catch(_) {
    entries.forEach(({ blob, name }) => downloadBlob(blob, name));
  } finally {
    downloadAllBtn.disabled = false;
    downloadAllBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 2v8M4 8l4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 13h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg> 下载全部文件`;
  }
});

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
}

async function fetchBlobFromURL(blobURL) {
  const res = await fetch(blobURL);
  return res.blob();
}

function loadJSZip() {
  return new Promise((resolve, reject) => {
    if (window.JSZip) { resolve(); return; }
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
    s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

// ==============================
// 初始化
// ==============================
function init() {
  setupUpload();
  setupFrameExtract();
  setupSpecCheckboxes();
  setupSampleModal();
}

document.addEventListener('DOMContentLoaded', init);
