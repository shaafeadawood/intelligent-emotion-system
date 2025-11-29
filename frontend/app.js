// API Configuration
// Prefer same-origin when served via http(s); fall back to localhost when opened as file://
const API_BASE_URL = (() => {
  try {
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      // If frontend is served on a dev port (e.g., 3000), point to backend port 8000
      const url = new URL(location.href);
      if (url.port === '3000') {
        return 'http://127.0.0.1:8000';
      }
      return `${location.origin}`;
    }
  } catch {}
  return 'http://127.0.0.1:8000';
})();

// Emotion to Emoji Mapping
const EMOTION_EMOJIS = {
  joy: '😊',
  sadness: '😢',
  anger: '😠',
  fear: '😨',
  surprise: '😲',
  disgust: '🤢',
  neutral: '😐',
  love: '❤️',
  happy: '😄',
  sad: '😔',
  angry: '😡'
};

// Global State
let mediaRecorder = null;
let audioChunks = [];
let recordedBlob = null;
let emotionChart = null;
let lastHistoryLogs = [];
let filteredHistoryLogs = [];
let timelineChart = null;
let historyCurrentPage = 1;
let historyPageSize = 10;
let memoryCurrentPage = 1;
let memoryPageSize = 10;
let lastMemories = [];

// DOM Elements
const textTab = document.querySelector('[data-tab="text"]');
const speechTab = document.querySelector('[data-tab="speech"]');
const textPanel = document.getElementById('text-panel');
const speechPanel = document.getElementById('speech-panel');
const analyzeTextBtn = document.getElementById('analyze-text');
const recordBtn = document.getElementById('record-btn');
const uploadBtn = document.getElementById('upload-btn');
const getResponseBtn = document.getElementById('get-response');
const loadHistoryBtn = document.getElementById('load-history');
const loadingOverlay = document.getElementById('loading-overlay');

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  setupTabs();
  setupTextAnalysis();
  setupAudioRecording();
  setupAdaptiveResponse();
  setupHistory();
  setupInsights();
  checkBackendConnection();
  hydrateUserIds();
  setupUserPanel();
  setupMemories();
  setupAccessibility();
  
  // Initialize Lucide icons
  if (typeof lucide !== 'undefined') {
    lucide.createIcons();
  }
});

// Check backend connection on load
async function checkBackendConnection() {
  try {
    const response = await fetch(`${API_BASE_URL}/health`, { 
      signal: AbortSignal.timeout(5000) 
    });
    if (response.ok) {
      showToast('✅ Connected to backend server', 'success');
    } else {
      showToast('⚠️ Backend server responded with error', 'warning');
    }
  } catch (error) {
    showToast('❌ Cannot connect to backend. Make sure server is running on port 8000', 'error');
    console.error('Backend connection failed:', error);
  }
}

// Tab Switching
function setupTabs() {
  textTab.addEventListener('click', () => switchTab('text'));
  speechTab.addEventListener('click', () => switchTab('speech'));
}

function switchTab(tab) {
  const tabs = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('.tab-content');
  
  tabs.forEach(t => {
    t.classList.remove('active');
    t.setAttribute('aria-selected', 'false');
  });
  panels.forEach(c => c.classList.remove('active'));
  
  if (tab === 'text') {
    textTab.classList.add('active');
    textTab.setAttribute('aria-selected', 'true');
    textPanel.classList.add('active');
  } else {
    speechTab.classList.add('active');
    speechTab.setAttribute('aria-selected', 'true');
    speechPanel.classList.add('active');
  }
  
  // Refresh Lucide icons after DOM update
  if (typeof lucide !== 'undefined') {
    lucide.createIcons();
  }
}

// Text Analysis
function setupTextAnalysis() {
  analyzeTextBtn.addEventListener('click', analyzeText);
  
  // Allow Enter key in textarea (Shift+Enter for newline)
  const textInput = document.getElementById('text-input');
  if (textInput) {
    textInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        analyzeText();
      }
    });
  }
}

async function analyzeText() {
  const userId = document.getElementById('user-id-text').value.trim();
  const text = document.getElementById('text-input').value.trim();
  
  if (!text) {
    showToast('Please enter some text to analyze', 'warning');
    document.getElementById('text-input').focus();
    return;
  }
  
  try {
    showLoading(true);
    const response = await fetch(`${API_BASE_URL}/predict-text?all_scores=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, user_id: userId || null, client_time: new Date().toISOString() })
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `Server error: ${response.status}`);
    }
    
    const result = await response.json();
    if (userId) setLastUserId(userId);
    displayResult(result, text);
    showToast('Analysis complete!', 'success');
  } catch (error) {
    console.error('Error:', error);
    let errorMsg = 'Failed to analyze text. ';
    if (error.message.includes('Failed to fetch')) {
      errorMsg += 'Backend server not reachable. Check if it\'s running.';
    } else {
      errorMsg += error.message;
    }
    showToast(errorMsg, 'error');
  } finally {
    showLoading(false);
  }
}

// Audio Recording
function setupAudioRecording() {
  recordBtn.addEventListener('click', toggleRecording);
  uploadBtn.addEventListener('click', uploadAndAnalyze);
  // File upload handlers
  const chooseFileBtn = document.getElementById('choose-file-btn');
  const analyzeFileBtn = document.getElementById('analyze-file-btn');
  const audioFileInput = document.getElementById('audio-file');

  if (chooseFileBtn && audioFileInput) {
    chooseFileBtn.addEventListener('click', () => audioFileInput.click());
    audioFileInput.addEventListener('change', () => {
      if (audioFileInput.files && audioFileInput.files[0]) {
        const file = audioFileInput.files[0];
        const fileNameSpan = document.getElementById('file-name');
        if (fileNameSpan) {
          fileNameSpan.textContent = file.name;
        }
        // Prepare preview
        recordedBlob = file;
        displayAudioPreview(recordedBlob);
        analyzeFileBtn.style.display = 'inline-flex';
        uploadBtn.style.display = 'none';
      }
    });
  }

  if (analyzeFileBtn) {
    analyzeFileBtn.addEventListener('click', uploadAndAnalyze);
  }
}

async function toggleRecording() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') {
    await startRecording();
  } else {
    stopRecording();
  }
}

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Prefer a codec Whisper can read; browser usually provides webm/opus
    const preferredType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus') ? 'audio/ogg;codecs=opus' : '');
    mediaRecorder = new MediaRecorder(stream, preferredType ? { mimeType: preferredType } : undefined);
    audioChunks = [];
    
    mediaRecorder.ondataavailable = (event) => {
      if (event && event.data && event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };
    
    mediaRecorder.onstop = () => {
      const blobType = mediaRecorder.mimeType || (audioChunks[0] && audioChunks[0].type) || 'audio/webm';
      try {
        recordedBlob = new Blob(audioChunks, { type: blobType });
      } catch (e) {
        // Fallback without type
        recordedBlob = new Blob(audioChunks);
      }
      displayAudioPreview(recordedBlob);
      stream.getTracks().forEach(track => track.stop());
    };
    
    mediaRecorder.start();
    updateRecorderStatus(true);
    recordBtn.innerHTML = '<i data-lucide="square"></i> Stop Recording';
    recordBtn.classList.add('recording');
    recordBtn.setAttribute('aria-label', 'Stop recording');
    uploadBtn.style.display = 'none';
    
    // Reinitialize Lucide icons
    if (typeof lucide !== 'undefined') {
      lucide.createIcons();
    }
  } catch (error) {
    console.error('Error accessing microphone:', error);
    showToast('Could not access microphone. Please check permissions.', 'error');
  }
}

async function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    // Wait for onstop to finalize blob creation
    const stopPromise = new Promise((resolve) => {
      const originalOnStop = mediaRecorder.onstop;
      mediaRecorder.onstop = (e) => {
        try {
          if (typeof originalOnStop === 'function') originalOnStop(e);
        } finally {
          resolve();
        }
      };
    });
    mediaRecorder.stop();
    await stopPromise;

    // If we somehow collected no data, notify the user
    if (!recordedBlob || (recordedBlob.size || 0) === 0) {
      showToast('Recorded audio seems empty. Try again or select a file.', 'warning');
    }

    updateRecorderStatus(false);
    recordBtn.innerHTML = '<i data-lucide="mic"></i> Start Recording';
    recordBtn.classList.remove('recording');
    recordBtn.setAttribute('aria-label', 'Start recording');
    uploadBtn.style.display = 'inline-flex';
    
    // Reinitialize Lucide icons
    if (typeof lucide !== 'undefined') {
      lucide.createIcons();
    }
  }
}

function updateRecorderStatus(recording) {
  const statusIndicator = document.querySelector('.status-indicator');
  const statusText = document.querySelector('.status-text');
  
  if (recording) {
    statusIndicator.classList.add('recording');
    statusText.textContent = 'Recording...';
  } else {
    statusIndicator.classList.remove('recording');
    statusText.textContent = 'Ready to record';
  }
}

async function displayAudioPreview(blob) {
  const audioPreview = document.getElementById('audio-preview');
  const audioPlayback = document.getElementById('audio-playback');
  
  // Try decoding to verify the blob actually contains audio frames
  let decodable = true;
  try {
    const arrBuf = await blob.arrayBuffer();
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      const ctx = new AudioCtx();
      await ctx.decodeAudioData(arrBuf.slice(0));
      ctx.close && ctx.close();
    }
  } catch (e) {
    decodable = false;
  }

  const url = URL.createObjectURL(blob);
  audioPlayback.srcObject = null;
  audioPlayback.src = url;
  audioPlayback.volume = 1.0;
  audioPlayback.muted = false;
  // Ensure the element reloads the new source and attempt to play
  try {
    audioPlayback.load();
    if (decodable) {
      // Some browsers block autoplay; we ignore rejection
      audioPlayback.play().catch(() => {});
    }
  } catch {}
  if (!decodable) {
    showToast('The recorded file could not be decoded. Try recording again or select a file.', 'warning');
  }
  audioPreview.style.display = 'block';
}

async function uploadAndAnalyze() {
  if (!recordedBlob) {
    showToast('No audio recorded', 'warning');
    return;
  }
  
  const userId = document.getElementById('user-id-speech').value.trim();
  
  try {
    showLoading(true);
    const formData = new FormData();
    // Choose filename extension based on blob type to help backend/Whisper
    const t = (recordedBlob && recordedBlob.type) || 'audio/webm';
    const ext = t.includes('ogg') ? 'ogg' : (t.includes('wav') ? 'wav' : (t.includes('m4a') ? 'm4a' : 'webm'));
    formData.append('file', recordedBlob, `recording.${ext}`);
    if (userId) formData.append('user_id', userId);
    formData.append('client_time', new Date().toISOString());
    
    const response = await fetch(`${API_BASE_URL}/predict-speech`, {
      method: 'POST',
      body: formData
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.detail || `Server error: ${response.status}`);
    }
    
    const result = await response.json();
    if (userId) setLastUserId(userId);
    const spokenText = result.transcript || result.transcription || 'Audio transcription';
    displayResult(result, spokenText);
    // Populate text field with the transcript so the user can see/edit it
    const textInput = document.getElementById('text-input');
    if (textInput && spokenText && !spokenText.startsWith('[audio file')) {
      textInput.value = spokenText;
    }
    // Also populate the dedicated speech transcript field
    const speechTranscript = document.getElementById('speech-transcript');
    if (speechTranscript && spokenText) {
      speechTranscript.value = spokenText;
    }
    showToast('Audio analysis complete!', 'success');
  } catch (error) {
    console.error('Error:', error);
    let errorMsg = 'Failed to analyze audio. ';
    if (error.message.includes('Failed to fetch')) {
      errorMsg += 'Backend server not reachable.';
    } else {
      errorMsg += error.message;
    }
    showToast(errorMsg, 'error');
  } finally {
    showLoading(false);
  }
}

// Display Result
function displayResult(result, message) {
  const resultSection = document.getElementById('result-section');
  const emojiEl = document.getElementById('emotion-emoji');
  const labelEl = document.getElementById('emotion-label');
  const fillEl = document.getElementById('confidence-fill');
  const textEl = document.getElementById('confidence-text');
  const metaEl = document.getElementById('result-meta');
  const confidenceBar = document.getElementById('confidence-bar-single');
  const confidenceBarDual = document.getElementById('confidence-bar-dual');
  const chipsContainer = document.getElementById('emotion-chips');
  
  const emotion = result.emotion.toLowerCase();
  const emoji = EMOTION_EMOJIS[emotion] || '😐';
  const confidence = (result.confidence * 100).toFixed(1);
  
  emojiEl.textContent = emoji;
  emojiEl.setAttribute('aria-label', `${result.emotion} emotion`);
  labelEl.textContent = result.emotion;
  
  // Clear chips
  chipsContainer.innerHTML = '';
  
  // Check for mixed emotions (top-2 with both > 25%)
  const hasTop = result.top && Array.isArray(result.top) && result.top.length >= 2;
  const top1 = hasTop ? result.top[0] : null;
  const top2 = hasTop ? result.top[1] : null;
  const isMixed = top1 && top2 && top2[1] >= 0.25;
  
  if (isMixed) {
    // Show dual progress bar
    confidenceBar.style.display = 'none';
    confidenceBarDual.style.display = 'flex';
    
    const pct1 = (top1[1] * 100).toFixed(0);
    const pct2 = (top2[1] * 100).toFixed(0);
    
    document.getElementById('confidence-segment-1').style.width = `${pct1}%`;
    document.getElementById('confidence-segment-2').style.width = `${pct2}%`;
    
    confidenceBarDual.setAttribute('aria-label', `${top1[0]}: ${pct1}%, ${top2[0]}: ${pct2}%`);
    
    // Render chips
    const chip1 = document.createElement('span');
    chip1.className = 'emotion-chip emotion-chip-primary';
    chip1.innerHTML = `${escapeHtml(top1[0])} <span class="emotion-chip-percent">${pct1}%</span>`;
    chipsContainer.appendChild(chip1);
    
    const chip2 = document.createElement('span');
    chip2.className = 'emotion-chip emotion-chip-secondary';
    chip2.innerHTML = `${escapeHtml(top2[0])} <span class="emotion-chip-percent">${pct2}%</span>`;
    chipsContainer.appendChild(chip2);
    
    textEl.textContent = `Mixed emotions detected`;
  } else {
    // Show single progress bar
    confidenceBar.style.display = 'block';
    confidenceBarDual.style.display = 'none';
    fillEl.style.width = `${confidence}%`;
    confidenceBar.setAttribute('aria-valuenow', confidence);
    textEl.textContent = `Confidence: ${confidence}%`;
  }
  
  metaEl.innerHTML = `
    <strong>Original Message:</strong> ${escapeHtml(message)}<br>
    ${result.user_id ? `<strong>User ID:</strong> ${escapeHtml(result.user_id)}<br>` : ''}
    <strong>Timestamp:</strong> ${new Date().toLocaleString()}
  `;
  
  resultSection.style.display = 'block';
  resultSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  
  // Show response section if user_id is present
  if (result.user_id) {
    document.getElementById('response-section').style.display = 'block';
  }

  // Auto-populate and refresh history if we have a user id
  const userId = (result.user_id || getLastUserId());
  if (userId) {
    const historyId = document.getElementById('history-user-id');
    if (historyId && !historyId.value) historyId.value = userId;
    // try refreshing history silently
    loadHistory().catch(() => {});
  }
  // Diagnostics panel: show backend hints to aid troubleshooting
  try {
    const diag = result && result._diag ? result._diag : null;
    let diagEl = document.getElementById('diag-panel');
    if (!diagEl) {
      diagEl = document.createElement('div');
      diagEl.id = 'diag-panel';
      diagEl.style.marginTop = '8px';
      diagEl.style.fontSize = '12px';
      diagEl.style.color = 'var(--text-muted, #666)';
      resultSection && resultSection.appendChild(diagEl);
    }
    if (diag) {
      const usedFallback = diag.used_fallback ? 'yes' : 'no';
      diagEl.textContent = `Audio: ${diag.content_type || 'unknown'} | duration: ${diag.duration ?? 'n/a'}s | ffmpeg fallback: ${usedFallback}`;
    } else {
      diagEl.textContent = '';
    }
  } catch {}
}

// Adaptive Response
function setupAdaptiveResponse() {
  getResponseBtn.addEventListener('click', async () => {
    const userId = document.getElementById('user-id-text').value.trim() || 
                   document.getElementById('user-id-speech').value.trim();
    
    if (!userId) {
      showToast('Please enter a User ID first', 'warning');
      return;
    }
    
    try {
      showLoading(true);
      const response = await fetch(`${API_BASE_URL}/respond?user_id=${userId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || `Server error: ${response.status}`);
      }
      
      const result = await response.json();
      displayAdaptiveResponse(result.response || result.message);
      showToast('Response generated!', 'success');
    } catch (error) {
      console.error('Error:', error);
      let errorMsg = 'Failed to generate response. ';
      if (error.message.includes('Failed to fetch')) {
        errorMsg += 'Backend server not reachable.';
      } else {
        errorMsg += error.message;
      }
      showToast(errorMsg, 'error');
    } finally {
      showLoading(false);
    }
  });
}

function displayAdaptiveResponse(message) {
  const responseText = document.getElementById('response-text');
  responseText.textContent = message;
  responseText.parentElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  const speakBtn = document.getElementById('speak-response');
  if (speakBtn) {
    speakBtn.onclick = () => {
      try {
        const utter = new SpeechSynthesisUtterance(message);
        utter.rate = 1.0;
        speechSynthesis.cancel();
        speechSynthesis.speak(utter);
      } catch (e) {
        console.warn('TTS not available', e);
        showToast('Speech not supported in this browser', 'warning');
      }
    };
  }
}

// History & Chart
function setupHistory() {
  loadHistoryBtn.addEventListener('click', loadHistory);
  
  // Setup pagination controls
  const historyPrev = document.getElementById('history-prev');
  const historyNext = document.getElementById('history-next');
  
  if (historyPrev) {
    historyPrev.addEventListener('click', () => {
      if (historyCurrentPage > 1) {
        historyCurrentPage--;
        displayHistoryTable(filteredHistoryLogs);
      }
    });
  }
  
  if (historyNext) {
    historyNext.addEventListener('click', () => {
      const maxPage = Math.ceil(filteredHistoryLogs.length / historyPageSize);
      if (historyCurrentPage < maxPage) {
        historyCurrentPage++;
        displayHistoryTable(filteredHistoryLogs);
      }
    });
  }
  
  // Setup since filter
  const sinceSelect = document.getElementById('history-since');
  if (sinceSelect) {
    sinceSelect.addEventListener('change', () => {
      applyHistoryFilter();
    });
  }
}

function applyHistoryFilter() {
  const sinceSelect = document.getElementById('history-since');
  const sinceDays = sinceSelect ? parseInt(sinceSelect.value) : 0;
  
  if (!sinceDays || !lastHistoryLogs.length) {
    filteredHistoryLogs = lastHistoryLogs;
  } else {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - sinceDays);
    filteredHistoryLogs = lastHistoryLogs.filter(log => new Date(log.timestamp) >= cutoff);
  }
  
  historyCurrentPage = 1;
  displayHistoryTable(filteredHistoryLogs);
  displayHistoryChart(filteredHistoryLogs);
  displayTimelineChart(filteredHistoryLogs);
  
  // Update insights with filtered window
  const userId = document.getElementById('history-user-id').value.trim();
  if (userId && sinceDays) {
    fetchInsights(userId, sinceDays).catch(() => {});
  }
}

async function loadHistory() {
  const userId = document.getElementById('history-user-id').value.trim();
  
  if (!userId) {
    showToast('Please enter a User ID', 'warning');
    document.getElementById('history-user-id').focus();
    return;
  }
  
  try {
    showLoading(true);
    // Request large page size to approximate prior behavior
    const response = await fetch(`${API_BASE_URL}/history?user_id=${encodeURIComponent(userId)}&page=1&page_size=1000&limit=1000`);
    if (!response.ok) throw new Error('Failed to load history');

    const data = await response.json();
    // Support both legacy array response and new paginated shape { page, page_size, items }
    let logs = [];
    if (Array.isArray(data)) {
      logs = data;
    } else if (data && Array.isArray(data.items)) {
      logs = data.items;
    }

    if (!logs.length) {
      showToast('No history found for this user', 'warning');
      displayEmptyHistory();
      return;
    }

    lastHistoryLogs = logs;
    applyHistoryFilter();
    showToast(`Loaded ${logs.length} records`, 'success');
  } catch (error) {
    console.error('Error:', error);
    let errorMsg = 'Failed to load history. ';
    if (error.message.includes('Failed to fetch')) {
      errorMsg += 'Backend server not reachable. Make sure the server is running on port 8000.';
    } else {
      errorMsg += error.message;
    }
    showToast(errorMsg, 'error');
    displayEmptyHistory();
  } finally {
    showLoading(false);
  }
}

// Insights Summary
function setupInsights() {
  const last = getLastUserId();
  if (last) {
    fetchInsights(last, 30).catch(() => {});
  }
}

async function fetchInsights(userId, windowDays = 30) {
  if (!userId) return;
  const totalEl = document.getElementById('insight-total');
  const topEl = document.getElementById('insight-top');
  const posEl = document.getElementById('insight-pos');
  const negEl = document.getElementById('insight-neg');
  const neuEl = document.getElementById('insight-neu');
  try {
    const res = await fetch(`${API_BASE_URL}/insights/summary?user_id=${encodeURIComponent(userId)}&window_days=${encodeURIComponent(windowDays)}`);
    if (!res.ok) throw new Error('Failed to load insights');
    const data = await res.json();
    if (totalEl) totalEl.textContent = String(data.total ?? '-');
    if (topEl) topEl.textContent = String(data.top_emotion ?? '-');
    const mix = data.mix || {};
    const pct = v => (typeof v === 'number' ? `${(v * 100).toFixed(0)}%` : '-');
    if (posEl) posEl.textContent = pct(mix.positive);
    if (negEl) negEl.textContent = pct(mix.negative);
    if (neuEl) neuEl.textContent = pct(mix.neutral);
  } catch (e) {
    if (totalEl) totalEl.textContent = '-';
    if (topEl) topEl.textContent = '-';
    if (posEl) posEl.textContent = '-';
    if (negEl) negEl.textContent = '-';
    if (neuEl) neuEl.textContent = '-';
  }
}

// Timeline Chart without time adapter (use linear x as timestamp)
function displayTimelineChart(logs) {
  const ctx = document.getElementById('emotion-timeline');
  if (!ctx) return;

  const set = new Set();
  logs.forEach(l => set.add((l.detected_emotion || l.emotion || 'unknown').toLowerCase()));
  const emotions = Array.from(set).sort();
  const indexMap = Object.fromEntries(emotions.map((e, i) => [e, i]));

  const points = logs.map(l => ({
    x: new Date(l.client_time || l.timestamp).getTime(),
    y: indexMap[(l.detected_emotion || l.emotion || 'unknown').toLowerCase()]
  })).sort((a,b) => a.x - b.x);

  if (timelineChart) timelineChart.destroy();
  timelineChart = new Chart(ctx, {
    type: 'scatter',
    data: {
      datasets: [{
        label: 'Emotion over time',
        data: points,
        pointBackgroundColor: '#6366f1',
        pointBorderColor: '#4f46e5',
        pointRadius: 4,
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        title: { display: true, text: 'Emotion Timeline' },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const d = ctx.raw;
              const t = new Date(d.x).toLocaleString();
              const e = emotions[d.y] || 'unknown';
              return `${t}: ${e}`;
            }
          }
        }
      },
      scales: {
        x: {
          type: 'linear',
          ticks: {
            callback: (v) => new Date(v).toLocaleTimeString()
          }
        },
        y: {
          ticks: {
            callback: (v) => emotions[v] || ''
          },
          beginAtZero: true,
          suggestedMax: Math.max(emotions.length - 1, 1)
        }
      }
    }
  });
}

function displayHistoryTable(logs) {
  const tbody = document.getElementById('history-body');
  const pagination = document.getElementById('history-pagination');
  const pageInfo = document.getElementById('history-page-info');
  const prevBtn = document.getElementById('history-prev');
  const nextBtn = document.getElementById('history-next');
  
  tbody.innerHTML = '';
  
  if (!logs || logs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-state">No history data available.</td></tr>';
    if (pagination) pagination.style.display = 'none';
    return;
  }
  
  // Calculate pagination
  const totalPages = Math.ceil(logs.length / historyPageSize);
  const startIdx = (historyCurrentPage - 1) * historyPageSize;
  const endIdx = Math.min(startIdx + historyPageSize, logs.length);
  const pageData = logs.slice(startIdx, endIdx);
  
  // Render rows
  pageData.forEach(log => {
    const row = tbody.insertRow();
    const time = new Date(log.client_time || log.timestamp).toLocaleString();
    const confidence = (log.confidence * 100).toFixed(1);
    const emotion = log.detected_emotion || log.emotion || 'unknown';
    
    row.innerHTML = `
      <td>${escapeHtml(time)}</td>
      <td>${escapeHtml(log.message || 'N/A')}</td>
      <td><strong>${escapeHtml(emotion)}</strong></td>
      <td>${confidence}%</td>
    `;
  });
  
  // Update pagination UI
  if (pagination && totalPages > 1) {
    pagination.style.display = 'flex';
    if (pageInfo) {
      pageInfo.textContent = `Page ${historyCurrentPage} of ${totalPages}`;
    }
    if (prevBtn) {
      prevBtn.disabled = historyCurrentPage === 1;
    }
    if (nextBtn) {
      nextBtn.disabled = historyCurrentPage === totalPages;
    }
  } else if (pagination) {
    pagination.style.display = 'none';
  }
}

function displayHistoryChart(logs) {
  const ctx = document.getElementById('emotion-chart');
  
  // Prepare data
  const emotionCounts = {};
  logs.forEach(log => {
    const emotion = log.detected_emotion || log.emotion || 'unknown';
    emotionCounts[emotion] = (emotionCounts[emotion] || 0) + 1;
  });
  
  const labels = Object.keys(emotionCounts);
  const data = Object.values(emotionCounts);
  const colors = labels.map((_, i) => {
    const hue = (i * 360) / labels.length;
    return `hsl(${hue}, 70%, 60%)`;
  });
  
  // Destroy existing chart
  if (emotionChart) {
    emotionChart.destroy();
  }
  
  // Create new chart
  emotionChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: 'Emotion Frequency',
        data: data,
        backgroundColor: colors,
        borderColor: colors.map(c => c.replace('60%', '40%')),
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: {
          display: false
        },
        title: {
          display: true,
          text: 'Emotion Distribution',
          font: {
            size: 16,
            weight: 'bold'
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            stepSize: 1
          }
        }
      }
    }
  });
}

function displayEmptyHistory() {
  const tbody = document.getElementById('history-body');
  const pagination = document.getElementById('history-pagination');
  tbody.innerHTML = '<tr><td colspan="4" class="empty-state">No history found for this user.</td></tr>';
  
  if (pagination) pagination.style.display = 'none';
  
  if (emotionChart) {
    emotionChart.destroy();
    emotionChart = null;
  }
  
  if (timelineChart) {
    timelineChart.destroy();
    timelineChart = null;
  }
}

// Export history as CSV (respects current filter)
function exportHistoryCSV() {
  const dataToExport = filteredHistoryLogs.length > 0 ? filteredHistoryLogs : lastHistoryLogs;
  
  if (!Array.isArray(dataToExport) || dataToExport.length === 0) {
    showToast('No history to export. Load history first.', 'warning');
    return;
  }
  
  const headers = ['timestamp','message','emotion','confidence'];
  const rows = dataToExport.map(log => [
    new Date(log.timestamp).toISOString(),
    (log.message || '').replace(/\n/g,' ').replace(/"/g,'""'),
    (log.detected_emotion || log.emotion || 'unknown'),
    (Number(log.confidence) * 100).toFixed(1) + '%'
  ]);
  const csv = [headers.join(','), ...rows.map(r => r.map(v => /[,"\n]/.test(v) ? `"${v}"` : v).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `emotion_history_${getLastUserId() || 'user'}_${new Date().toISOString().split('T')[0]}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast(`Exported ${dataToExport.length} records as CSV`, 'success');
}

// User ID persistence helpers
function setLastUserId(id) {
  try {
    localStorage.setItem('last_user_id', id);
    // propagate to fields
    const ids = ['user-id-text','user-id-speech','history-user-id'];
    ids.forEach(el => { const n = document.getElementById(el); if (n && !n.value) n.value = id; });
  } catch {}
}

function getLastUserId() {
  try { return localStorage.getItem('last_user_id') || ''; } catch { return ''; }
}

function hydrateUserIds() {
  const id = getLastUserId();
  if (!id) return;
  ['user-id-text','user-id-speech','history-user-id'].forEach(el => {
    const n = document.getElementById(el);
    if (n && !n.value) n.value = id;
  });
}

// User panel
function setupUserPanel() {
  const saveBtn = document.getElementById('user-save');
  const loadBtn = document.getElementById('user-load');
  const statusEl = document.getElementById('user-panel-status');
  const idInput = document.getElementById('user-panel-id');
  const nameInput = document.getElementById('user-panel-name');
  const styleInput = document.getElementById('user-panel-style');
  const prefsInput = document.getElementById('user-panel-preferences');

  const last = getLastUserId();
  if (last && idInput && !idInput.value) idInput.value = last;

  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const user_id = idInput.value.trim();
      if (!user_id) { showToast('Enter a User ID', 'warning'); return; }
      const body = {
        user_id,
        name: nameInput.value.trim() || null,
        interaction_style: styleInput.value.trim() || null,
        preferences: (prefsInput.value || '').split(',').map(s => s.trim()).filter(Boolean)
      };
      try {
        showLoading(true);
        const res = await fetch(`${API_BASE_URL}/users`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.detail || 'Failed to save user');
        setLastUserId(user_id);
        statusEl.textContent = `Saved user ${user_id}`;
        showToast('User saved', 'success');
      } catch (e) {
        statusEl.textContent = 'Error: ' + e.message;
        showToast(e.message, 'error');
      } finally { showLoading(false); }
    });
  }

  if (loadBtn) {
    loadBtn.addEventListener('click', async () => {
      const user_id = idInput.value.trim();
      if (!user_id) { showToast('Enter a User ID', 'warning'); return; }
      try {
        showLoading(true);
        const res = await fetch(`${API_BASE_URL}/users/${encodeURIComponent(user_id)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'User not found');
        nameInput.value = data.name || '';
        styleInput.value = data.interaction_style || '';
        prefsInput.value = (data.preferences || []).join(', ');
        setLastUserId(user_id);
        statusEl.textContent = `Loaded user ${user_id}`;
        showToast('User loaded', 'success');
      } catch (e) {
        statusEl.textContent = 'Error: ' + e.message;
        showToast(e.message, 'error');
      } finally { showLoading(false); }
    });
  }
}

// Memories UI
function setupMemories() {
  const saveBtn = document.getElementById('save-memory');
  const loadBtn = document.getElementById('load-memories');
  const typeInput = document.getElementById('memory-type');
  const contentInput = document.getElementById('memory-content');
  const importanceSel = document.getElementById('memory-importance');
  
  // Setup pagination controls
  const memoryPrev = document.getElementById('memory-prev');
  const memoryNext = document.getElementById('memory-next');
  
  if (memoryPrev) {
    memoryPrev.addEventListener('click', () => {
      if (memoryCurrentPage > 1) {
        memoryCurrentPage--;
        displayMemories(lastMemories);
      }
    });
  }
  
  if (memoryNext) {
    memoryNext.addEventListener('click', () => {
      const maxPage = Math.ceil(lastMemories.length / memoryPageSize);
      if (memoryCurrentPage < maxPage) {
        memoryCurrentPage++;
        displayMemories(lastMemories);
      }
    });
  }

  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const user_id = getLastUserId() || document.getElementById('history-user-id').value.trim();
      if (!user_id) { 
        showToast('Set a User ID first', 'warning');
        document.getElementById('history-user-id').focus();
        return;
      }
      const body = {
        user_id,
        memory_type: typeInput.value.trim() || 'note',
        memory_content: contentInput.value.trim(),
        importance: importanceSel.value || 'normal'
      };
      if (!body.memory_content) { 
        showToast('Enter memory content', 'warning');
        contentInput.focus();
        return;
      }
      try {
        showLoading(true);
        const res = await fetch(`${API_BASE_URL}/memory`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.detail || 'Failed to save memory');
        showToast('Memory saved', 'success');
        typeInput.value = '';
        contentInput.value = '';
        memoryCurrentPage = 1;
        loadMemories();
      } catch (e) {
        showToast(e.message, 'error');
      } finally { showLoading(false); }
    });
  }

  if (loadBtn) {
    loadBtn.addEventListener('click', () => loadMemories());
  }
}

async function loadMemories() {
  const user_id = getLastUserId() || document.getElementById('history-user-id').value.trim();
  if (!user_id) { 
    showToast('Set a User ID first', 'warning');
    return;
  }
  try {
    showLoading(true);
    const res = await fetch(`${API_BASE_URL}/memory?user_id=${encodeURIComponent(user_id)}&limit=1000`);
    if (!res.ok) throw new Error('Failed to load memories');
    const data = await res.json();
    lastMemories = data || [];
    displayMemories(lastMemories);
    if (lastMemories.length > 0) {
      showToast(`Loaded ${lastMemories.length} memories`, 'success');
    }
  } catch (e) {
    showToast(e.message, 'error');
    lastMemories = [];
    displayMemories([]);
  } finally { showLoading(false); }
}

function displayMemories(items) {
  const tbody = document.getElementById('memory-body');
  const pagination = document.getElementById('memory-pagination');
  const pageInfo = document.getElementById('memory-page-info');
  const prevBtn = document.getElementById('memory-prev');
  const nextBtn = document.getElementById('memory-next');
  
  if (!tbody) return;
  
  tbody.innerHTML = '';
  
  if (!items || items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-state">No memories yet. Add one above.</td></tr>';
    if (pagination) pagination.style.display = 'none';
    return;
  }
  
  // Calculate pagination
  const totalPages = Math.ceil(items.length / memoryPageSize);
  const startIdx = (memoryCurrentPage - 1) * memoryPageSize;
  const endIdx = Math.min(startIdx + memoryPageSize, items.length);
  const pageData = items.slice(startIdx, endIdx);
  
  // Render rows
  pageData.forEach(m => {
    const row = tbody.insertRow();
    const time = m.created_at ? new Date(m.created_at).toLocaleString() : '-';
    row.innerHTML = `
      <td>${escapeHtml(time)}</td>
      <td>${escapeHtml(m.memory_type || '-')}</td>
      <td>${escapeHtml(m.importance || '-')}</td>
      <td>${escapeHtml(m.memory_content || '')}</td>
    `;
  });
  
  // Update pagination UI
  if (pagination && totalPages > 1) {
    pagination.style.display = 'flex';
    if (pageInfo) {
      pageInfo.textContent = `Page ${memoryCurrentPage} of ${totalPages}`;
    }
    if (prevBtn) {
      prevBtn.disabled = memoryCurrentPage === 1;
    }
    if (nextBtn) {
      nextBtn.disabled = memoryCurrentPage === totalPages;
    }
  } else if (pagination) {
    pagination.style.display = 'none';
  }
}

// Utility Functions
function showLoading(show) {
  loadingOverlay.classList.toggle('active', show);
}

function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.setAttribute('role', 'alert');
  
  const icons = {
    success: '✅',
    error: '❌',
    warning: '⚠️'
  };
  
  toast.innerHTML = `
    <span class="toast-icon" aria-hidden="true">${icons[type] || '📌'}</span>
    <span class="toast-message">${escapeHtml(message)}</span>
  `;
  
  container.appendChild(toast);
  
  setTimeout(() => {
    toast.style.animation = 'slideIn 0.3s ease reverse';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// HTML Escaping for security
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Accessibility enhancements
function setupAccessibility() {
  // Keyboard navigation for tabs
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        tab.click();
      }
    });
  });
  
  // Skip to main content (for screen readers)
  document.addEventListener('keydown', (e) => {
    if (e.key === 's' && e.altKey) {
      e.preventDefault();
      const main = document.querySelector('main');
      if (main) {
        main.setAttribute('tabindex', '-1');
        main.focus();
      }
    }
  });
  
  // Ensure export button has proper handler
  const exportBtn = document.getElementById('export-csv');
  if (exportBtn) {
    exportBtn.onclick = exportHistoryCSV;
  }
}
