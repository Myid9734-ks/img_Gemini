const $ = (sel) => document.querySelector(sel);
const promptList = $('#promptList');
let promptCount = 0;

// --- Content script 주입 보장 ---
async function ensureContentScript(tabId) {
  try {
    // 먼저 ping으로 이미 주입되었는지 확인
    await chrome.tabs.sendMessage(tabId, { action: 'ping' });
  } catch {
    // 응답 없으면 content script 주입
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
    // 주입 후 초기화 대기
    await new Promise((r) => setTimeout(r, 500));
  }
}

// --- 프롬프트 아이템 추가 ---
function addPromptItem(title = '', text = '') {
  promptCount++;
  const idx = promptCount;
  const div = document.createElement('div');
  div.className = 'prompt-item';
  div.dataset.idx = idx;
  div.innerHTML = `
    <div class="item-header">
      <input class="item-title" style="background:none;border:none;color:#8ab4f8;font-size:12px;font-weight:600;width:70%;"
             value="${title || '프롬프트 ' + idx}" />
      <button class="btn-remove" title="삭제">&times;</button>
    </div>
    <textarea placeholder="이 블록의 프롬프트를 입력하세요...">${text}</textarea>
  `;
  div.querySelector('.btn-remove').addEventListener('click', () => div.remove());
  promptList.appendChild(div);
  // 새 항목으로 스크롤
  div.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('#btnAdd').addEventListener('click', () => addPromptItem());

// --- 초기화 버튼 ---
$('#btnReset').addEventListener('click', () => {
  $('#bulkPaste').value = '';
  $('#commonStyle').value = '';
  promptList.innerHTML = '';
  promptCount = 0;
  addPromptItem();
  chrome.storage.local.remove('batchState');
  $('#status').textContent = '초기화 완료';
});

// 붙여넣기 영역에 Ctrl+V 시 자동 분류 (붙여넣기 직후)
$('#bulkPaste').addEventListener('paste', (e) => {
  // paste 이벤트 후 value가 반영되도록 약간 지연
  setTimeout(() => {
    const raw = $('#bulkPaste').value.trim();
    if (raw) parseBulkPrompt(raw);
  }, 100);
});

function parseBulkPrompt(raw) {
  // 두 가지 섹션 헤더 패턴 지원:
  // 1) [섹션명] 괄호 형식 — [공통 스타일], [메인 썸네일], [소제목2] 등
  // 2) ■ 소제목 N: 제목 형식 — ■ 소제목 1: 5년 만에 그가 왔다 등
  const sectionRegex = /^(?:(\[(?:공통\s*스타일|메인\s*썸네일|소제목\s*\d[^\]]*|[가-힣a-zA-Z][^\]]{0,30})\])|(■\s*소제목\s*\d+\s*[:：]\s*.+))\s*/gm;
  const sections = [];
  let match;

  // 모든 섹션 헤더 위치를 찾는다
  const headers = [];
  while ((match = sectionRegex.exec(raw)) !== null) {
    let title;
    if (match[1]) {
      // [섹션명] 형식
      const titleMatch = match[1].match(/^\[(.+)\]$/);
      if (!titleMatch) continue;
      title = titleMatch[1].trim();
    } else if (match[2]) {
      // ■ 소제목 N: 제목 형식
      title = match[2].replace(/^■\s*/, '').trim();
    }
    headers.push({
      title,
      start: match.index,
      contentStart: match.index + match[0].length,
    });
  }

  if (headers.length === 0) {
    $('#status').textContent = '⚠ [섹션명] 또는 ■ 소제목 패턴을 찾을 수 없습니다.';
    return;
  }

  // 각 섹션의 본문을 추출
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const nextStart = i + 1 < headers.length ? headers[i + 1].start : raw.length;
    const body = raw.substring(h.contentStart, nextStart).trim();
    sections.push({ title: h.title, body });
  }

  // [공통 스타일] 섹션 모두 찾기
  const commonIndices = [];
  sections.forEach((s, i) => {
    if (/공통\s*스타일/i.test(s.title)) commonIndices.push(i);
  });

  // 기존 슬롯 초기화
  promptList.innerHTML = '';
  promptCount = 0;

  if (commonIndices.length <= 1) {
    // 공통 스타일 0~1개: 기존 동작
    const commonIdx = commonIndices.length === 1 ? commonIndices[0] : -1;
    if (commonIdx !== -1) {
      $('#commonStyle').value = sections[commonIdx].body;
      sections.forEach((s, i) => {
        if (i === commonIdx) return;
        addPromptItem(s.title, s.body);
      });
    } else {
      $('#commonStyle').value = sections[0].body;
      sections.slice(1).forEach((s) => addPromptItem(s.title, s.body));
    }
  } else {
    // 공통 스타일 2개 이상: 각 프롬프트에 해당 공통 스타일을 인라인
    $('#commonStyle').value = '';
    for (let i = 0; i < sections.length; i++) {
      if (/공통\s*스타일/i.test(sections[i].title)) continue;
      // 가장 가까운 이전 공통 스타일 찾기
      let applicableStyle = '';
      for (let j = i - 1; j >= 0; j--) {
        if (/공통\s*스타일/i.test(sections[j].title)) {
          applicableStyle = sections[j].body;
          break;
        }
      }
      const combinedText = applicableStyle
        ? applicableStyle + '\n\n' + sections[i].body
        : sections[i].body;
      addPromptItem(sections[i].title, combinedText);
    }
  }

  // 붙여넣기 영역 비우기
  $('#bulkPaste').value = '';

  saveState();
  const totalPrompts = sections.length - commonIndices.length;
  $('#status').textContent = `✅ ${sections.length}개 섹션 분류 완료 (공통 ${commonIndices.length} + 개별 ${totalPrompts})`;
}

// --- 저장 / 불러오기 ---
function saveState() {
  const items = [...document.querySelectorAll('.prompt-item')].map((el) => ({
    title: el.querySelector('.item-title').value,
    text: el.querySelector('textarea').value,
  }));
  const data = {
    commonStyle: $('#commonStyle').value,
    delay: parseInt($('#delay').value, 10) || 3,
    items,
  };
  chrome.storage.local.set({ batchState: data });
}

function loadState() {
  chrome.storage.local.get('batchState', ({ batchState }) => {
    if (!batchState) {
      // 기본 프롬프트 슬롯 하나 추가
      addPromptItem();
      return;
    }
    $('#commonStyle').value = batchState.commonStyle || '';
    $('#delay').value = batchState.delay || 3;
    (batchState.items || []).forEach((it) => addPromptItem(it.title, it.text));
    if (!batchState.items || batchState.items.length === 0) addPromptItem();
  });
}
loadState();

// --- 초기 실행 시 Gemini 탭 확인 ---
let batchTabId = null; // 배치 실행 중인 Gemini 탭 ID

/** 선택된 계정에 맞는 Gemini URL 반환 */
function getGeminiUrl() {
  const idx = parseInt($('#accountSelect')?.value || '0', 10);
  return idx === 0
    ? 'https://gemini.google.com/app'
    : `https://gemini.google.com/u/${idx}/app`;
}

/** Gemini 탭을 찾거나, 별도 창으로 열어서 탭 반환 */
async function getOrOpenGeminiTab() {
  const geminiUrl = getGeminiUrl();

  // 1차: 이미 열린 해당 계정의 Gemini 탭이 있는지 검색
  const geminiTabs = await chrome.tabs.query({ url: ['https://gemini.google.com/*', 'https://aistudio.google.com/*'] });
  for (const tab of geminiTabs) {
    // 같은 계정 URL인지 확인
    if (tab.url && tab.url.startsWith(geminiUrl.replace('/app', ''))) {
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return tab;
    }
  }

  // 2차: 별도 창(window)으로 Gemini 열기 — 스로틀링 방지
  const newWindow = await chrome.windows.create({
    url: geminiUrl,
    type: 'normal',
    width: 1100,
    height: 900,
  });

  const newTab = newWindow.tabs[0];

  // 페이지 로드 완료 대기
  await new Promise((resolve) => {
    const listener = (tabId, changeInfo) => {
      if (tabId === newTab.id && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });

  const updatedTab = await chrome.tabs.get(newTab.id);
  return updatedTab;
}

// 입력 변경 시 자동 저장 (디바운스)
let saveTimer;
document.addEventListener('input', () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 500);
});

// --- 폴더명 생성 ---
function generateFolderName(commonStyle, prompts) {
  // 타입 판별: infographic/인포그래픽 키워드 존재 시 인포그래픽, 아니면 실사
  const lower = (commonStyle || '').toLowerCase();
  const type = (lower.includes('infographic') || lower.includes('인포그래픽')) ? '인포그래픽' : '실사';

  // 날짜: MMDD
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');

  // 제목 추출: 메인 썸네일 프롬프트에서 HEADLINE 값 시도
  let title = '';
  const mainPrompt = prompts.find((p) => /메인\s*썸네일/i.test(p.title));
  if (mainPrompt) {
    // HEADLINE: "..." 또는 HEADLINE: ... 패턴 매칭
    const headlineMatch = mainPrompt.text.match(/HEADLINE[:\s]*[""]?([^"""\n]+)/i);
    if (headlineMatch) {
      title = headlineMatch[1].trim();
    }
  }

  // HEADLINE 못 찾으면 첫 번째 프롬프트 제목 사용
  if (!title && prompts.length > 0) {
    title = prompts[0].title;
  }

  // 제목 정리: 특수문자 제거, 공백→언더스코어, 길이 제한
  title = title.replace(/[^a-zA-Z0-9가-힣\s_-]/g, '').trim().replace(/\s+/g, '_').substring(0, 40);

  return `Gemini_${mm}${dd}_${type}_${title || 'batch'}`;
}

// --- 실행 ---
let retryCount = 0;
const MAX_RETRIES = 2;
let lastQueue = null;
let lastDelay = 3000;

/** 배치 데이터(queue, delay, folderName) 준비 */
function prepareBatch() {
  const commonStyle = $('#commonStyle').value.trim();
  const items = [...document.querySelectorAll('.prompt-item')];
  const prompts = items
    .map((el) => ({
      el,
      title: el.querySelector('.item-title').value,
      text: el.querySelector('textarea').value.trim(),
    }))
    .filter((p) => p.text.length > 0);

  if (prompts.length === 0) return null;

  const delay = (parseInt($('#delay').value, 10) || 3) * 1000;

  const queue = prompts.map((p) => {
    const textToCheck = (commonStyle + ' ' + p.text).toLowerCase();
    const isInfographic = textToCheck.includes('infographic') || textToCheck.includes('인포그래픽');
    const prefix = isInfographic
      ? '블로그 포스팅에 삽입할 인포그래픽 썸네일 이미지를 생성해줘. 아래 설명을 따라줘:'
      : '블로그 포스팅에 삽입할 이미지를 생성해줘. 아래 설명을 따라줘:';
    return {
      combined: prefix + '\n\n' + (commonStyle ? commonStyle + '\n\n' : '') + p.text,
      title: p.title,
    };
  });

  const folderName = generateFolderName(commonStyle, prompts);

  return { queue, delay, folderName, items };
}

/** 배치 실행 (신규 또는 재시도) */
async function runBatchFromPopup(queue, delay, folderName) {
  // Gemini 새 창 열기
  $('#status').textContent = retryCount > 0
    ? `🔄 재시도 ${retryCount}/${MAX_RETRIES} — Gemini 새 창 열기...`
    : 'Gemini 탭 확인 중...';

  const tab = await getOrOpenGeminiTab();
  await new Promise((r) => setTimeout(r, 1000));

  $('#btnStart').disabled = true;
  $('#btnStop').disabled = false;

  // 아이템 상태 초기화
  document.querySelectorAll('.prompt-item').forEach((el) => el.classList.remove('done', 'active'));

  try {
    lastFolderName = folderName;
    lastQueue = queue;
    lastDelay = delay;
    batchTabId = tab.id;

    const retryLabel = retryCount > 0 ? ` (재시도 ${retryCount}/${MAX_RETRIES})` : '';
    appendLog({ timestamp: new Date().toISOString(), level: 'INFO', category: 'POPUP', message: `배치 시작 요청${retryLabel}: ${queue.length}건, 간격 ${delay/1000}초, 폴더: ${folderName}` });
    appendLog({ timestamp: new Date().toISOString(), level: 'INFO', category: 'POPUP', message: `대상 탭: id=${tab.id}, url=${tab.url}, windowId=${tab.windowId}` });

    await ensureContentScript(tab.id);
    appendLog({ timestamp: new Date().toISOString(), level: 'INFO', category: 'POPUP', message: 'Content script 준비 완료' });

    try {
      await chrome.tabs.sendMessage(tab.id, { action: 'stopBatch' });
      await new Promise((r) => setTimeout(r, 500));
    } catch { /* 이전 script 없으면 무시 */ }

    chrome.tabs.sendMessage(tab.id, {
      action: 'startBatch',
      queue,
      delay,
      folderName,
    });
  } catch (err) {
    appendLog({ timestamp: new Date().toISOString(), level: 'ERROR', category: 'POPUP', message: `Content script 주입 실패: ${err.message}` });
    resetUI(`❌ Content script 주입 실패: ${err.message}`);
  }
}

/** 파일 삭제 → 창 닫기 → 새 창에서 재시도 */
async function retryBatch() {
  retryCount++;
  appendLog({ timestamp: new Date().toISOString(), level: 'WARN', category: 'RETRY', message: `🔄 재시도 시작 (${retryCount}/${MAX_RETRIES})` });

  // 1. 기존 파일 삭제
  $('#status').textContent = '🗑 이전 파일 삭제 중...';
  await new Promise((resolve) => {
    chrome.runtime.sendMessage({ action: 'deleteDownloads', folder: lastFolderName }, (res) => {
      appendLog({ timestamp: new Date().toISOString(), level: 'INFO', category: 'RETRY', message: `파일 삭제: ${res?.deleted || 0}개` });
      resolve();
    });
  });

  // 2. 기존 Gemini 창 닫기
  $('#status').textContent = '🔄 기존 창 닫는 중...';
  if (batchTabId) {
    try {
      const tab = await chrome.tabs.get(batchTabId);
      await chrome.windows.remove(tab.windowId);
      appendLog({ timestamp: new Date().toISOString(), level: 'INFO', category: 'RETRY', message: `기존 창 닫기 완료 (windowId: ${tab.windowId})` });
    } catch {
      appendLog({ timestamp: new Date().toISOString(), level: 'WARN', category: 'RETRY', message: '기존 창 이미 닫힘' });
    }
    batchTabId = null;
  }

  // 3. 잠시 대기 후 새 창에서 재시작
  await new Promise((r) => setTimeout(r, 2000));
  await runBatchFromPopup(lastQueue, lastDelay, lastFolderName);
}

$('#btnStart').addEventListener('click', async () => {
  saveState();
  retryCount = 0;

  const batch = prepareBatch();
  if (!batch) {
    $('#status').textContent = '⚠ 프롬프트를 하나 이상 입력하세요.';
    return;
  }

  await runBatchFromPopup(batch.queue, batch.delay, batch.folderName);
});

$('#btnStop').addEventListener('click', async () => {
  const tabId = batchTabId;
  if (tabId) {
    try {
      chrome.tabs.sendMessage(tabId, { action: 'stopBatch' });
    } catch { /* ignore */ }
  }
  resetUI('중지됨');
});

function resetUI(statusText) {
  $('#btnStart').disabled = false;
  $('#btnStop').disabled = true;
  $('#status').textContent = statusText || '';
}

// --- 로그 패널 ---
const logPanel = $('#logPanel');

function appendLog(entry) {
  if (!logPanel) return;
  logEntries.push(entry);
  const line = document.createElement('div');
  line.className = `log-line log-${entry.level}`;

  const time = entry.timestamp ? entry.timestamp.split('T')[1].split('.')[0] : '';
  const dataStr = entry.data ? ` ${JSON.stringify(entry.data)}` : '';

  line.innerHTML = `<span class="log-time">${time}</span><span class="log-cat">[${entry.category}]</span>${entry.message}${dataStr}`;
  logPanel.appendChild(line);
  logPanel.scrollTop = logPanel.scrollHeight;
}

const logEntries = []; // popup 측 로그 저장
let lastFolderName = ''; // 마지막 배치 폴더명 기억

$('#btnClearLog').addEventListener('click', () => {
  logPanel.innerHTML = '';
  logEntries.length = 0;
});

$('#btnExportLog').addEventListener('click', () => {
  if (logEntries.length === 0) {
    $('#status').textContent = '⚠ 내보낼 로그가 없습니다.';
    return;
  }
  const text = logEntries.map(e => {
    const dataStr = e.data ? ` | ${JSON.stringify(e.data)}` : '';
    return `${e.timestamp} [${e.level}][${e.category}] ${e.message}${dataStr}`;
  }).join('\n');

  const blob = new Blob([text], { type: 'text/plain' });
  const dataUrl = URL.createObjectURL(blob);
  const now = new Date();
  const ts = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
  const fileName = `batch_log_${ts}.txt`;
  const fullPath = lastFolderName ? `${lastFolderName}/${fileName}` : fileName;

  chrome.downloads.download({
    url: dataUrl,
    filename: fullPath,
    saveAs: false,
  }, (downloadId) => {
    URL.revokeObjectURL(dataUrl);
    if (chrome.runtime.lastError) {
      $('#status').textContent = `❌ 로그 저장 실패: ${chrome.runtime.lastError.message}`;
    } else {
      $('#status').textContent = `📄 로그 저장: ${fullPath}`;
    }
  });
});

// content script에서 오는 진행 메시지 수신
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'batchProgress') {
    const { current, total, title, state } = msg;
    $('#status').textContent = `[${current}/${total}] ${title} — ${state}`;

    // 아이템 하이라이트
    const items = [...document.querySelectorAll('.prompt-item')];
    items.forEach((el, i) => {
      el.classList.remove('active');
      if (i < current - 1) el.classList.add('done');
      if (i === current - 1) el.classList.add('active');
    });
  }

  if (msg.type === 'batchDone') {
    (async () => {
      const hasMidFailure = (msg.failed || 0) > 0;

      const expected = msg.total;
      const succeeded = msg.succeeded || 0;
      const failed = msg.failed || 0;

      appendLog({ timestamp: new Date().toISOString(), level: 'INFO', category: 'RESULT', message: `📁 폴더: ${lastFolderName || '(없음)'}` });
      appendLog({ timestamp: new Date().toISOString(), level: 'INFO', category: 'RESULT', message: `📊 요청: ${expected}건 → 성공: ${succeeded}건, 실패: ${failed}건` });

      const needRetry = hasMidFailure || succeeded < expected;

      if (needRetry && retryCount < MAX_RETRIES) {
        const reason = hasMidFailure
          ? `중간 실패 ${failed}건`
          : `성공 수 부족 (${succeeded}/${expected})`;
        appendLog({ timestamp: new Date().toISOString(), level: 'WARN', category: 'RESULT', message: `⚠ ${reason} — 자동 재시도 진행` });
        $('#status').textContent = `⚠ ${reason} — 재시도 준비 중...`;
        await retryBatch();
      } else if (needRetry && retryCount >= MAX_RETRIES) {
        appendLog({ timestamp: new Date().toISOString(), level: 'ERROR', category: 'RESULT', message: `❌ 최대 재시도 ${MAX_RETRIES}회 초과 — 수동 확인 필요` });
        resetUI(`❌ ${MAX_RETRIES}회 재시도 후에도 실패 (성공: ${succeeded}/${expected})`);
        $('#commonStyle').value = '';
        promptList.innerHTML = '';
        promptCount = 0;
        addPromptItem();
        chrome.storage.local.remove('batchState');
      } else {
        // 성공 — Gemini 창 닫기
        appendLog({ timestamp: new Date().toISOString(), level: 'INFO', category: 'RESULT', message: `✅ 전체 완료! (${succeeded}/${expected})` });
        resetUI(`✅ 전체 ${expected}건 완료 — 성공: ${succeeded}건`);
        retryCount = 0;
        if (batchTabId) {
          try {
            const tab = await chrome.tabs.get(batchTabId);
            await chrome.windows.remove(tab.windowId);
            appendLog({ timestamp: new Date().toISOString(), level: 'INFO', category: 'RESULT', message: `Gemini 창 닫기 완료` });
          } catch { /* 이미 닫힘 */ }
          batchTabId = null;
        }
        $('#commonStyle').value = '';
        promptList.innerHTML = '';
        promptCount = 0;
        addPromptItem();
        chrome.storage.local.remove('batchState');
      }
    })();
  }

  if (msg.type === 'batchError') {
    appendLog({ timestamp: new Date().toISOString(), level: 'ERROR', category: 'POPUP', message: `배치 오류: ${msg.error}` });
    if (retryCount < MAX_RETRIES && lastQueue) {
      appendLog({ timestamp: new Date().toISOString(), level: 'WARN', category: 'POPUP', message: `오류 발생 — 자동 재시도 진행` });
      retryBatch();
    } else {
      resetUI(`❌ 오류: ${msg.error}`);
    }
  }

  if (msg.type === 'batchStopped') {
    resetUI('⏹ 중지됨');
  }

  // 로그 메시지 수신
  if (msg.type === 'batchLog') {
    appendLog(msg.entry);
  }

  // 배치 결과 요약
  if (msg.type === 'batchSummary') {
    const s = msg.summary;
    appendLog({
      level: 'INFO', category: 'SUMMARY', timestamp: new Date().toISOString(),
      message: `━━ 결과: 전체 ${s.total} | 성공 ${s.succeeded} | 실패 ${s.failed} ━━`,
    });
    if (s.results) {
      s.results.forEach(r => {
        appendLog({
          level: r.success ? 'INFO' : 'ERROR', category: 'SUMMARY', timestamp: new Date().toISOString(),
          message: `${r.success ? '✅' : '❌'} [${r.index}] ${r.title} → ${r.verdict}`,
        });
      });
    }
  }
});
