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
  // [섹션명] 패턴으로 분할
  // 줄의 시작에서 [한글/영문 섹션명] 형태만 매칭 (본문 내 [...]는 무시)
  // 섹션명은 한글, 영문, 숫자, 공백, 콜론, 쉼표 등 허용
  const sectionRegex = /^(\[(?:공통\s*스타일|메인\s*썸네일|소제목\s*\d[^\]]*|[가-힣a-zA-Z][^\]]{0,30})\])\s*/gm;
  const sections = [];
  let match;

  // 모든 [섹션] 헤더 위치를 찾는다
  const headers = [];
  while ((match = sectionRegex.exec(raw)) !== null) {
    // 대괄호 안의 내용 추출
    const titleMatch = match[1].match(/^\[(.+)\]$/);
    if (!titleMatch) continue;
    headers.push({
      title: titleMatch[1].trim(),
      start: match.index,
      contentStart: match.index + match[0].length,
    });
  }

  if (headers.length === 0) {
    $('#status').textContent = '⚠ [섹션명] 패턴을 찾을 수 없습니다.';
    return;
  }

  // 각 섹션의 본문을 추출
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const nextStart = i + 1 < headers.length ? headers[i + 1].start : raw.length;
    const body = raw.substring(h.contentStart, nextStart).trim();
    sections.push({ title: h.title, body });
  }

  // [공통 스타일] 섹션 찾기
  const commonIdx = sections.findIndex((s) =>
    /공통\s*스타일/i.test(s.title)
  );

  // 기존 슬롯 초기화
  promptList.innerHTML = '';
  promptCount = 0;

  if (commonIdx !== -1) {
    $('#commonStyle').value = sections[commonIdx].body;
    // 나머지를 개별 프롬프트로
    sections.forEach((s, i) => {
      if (i === commonIdx) return;
      addPromptItem(s.title, s.body);
    });
  } else {
    // 공통 스타일이 없으면 첫 번째를 공통으로, 나머지를 개별로
    $('#commonStyle').value = sections[0].body;
    sections.slice(1).forEach((s) => addPromptItem(s.title, s.body));
  }

  // 붙여넣기 영역 비우기
  $('#bulkPaste').value = '';

  saveState();
  $('#status').textContent = `✅ ${sections.length}개 섹션 분류 완료 (공통 1 + 개별 ${sections.length - 1})`;
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
/** Gemini 탭을 찾거나, 없으면 현재 탭을 Gemini로 이동시키고 탭 반환 */
async function getOrOpenGeminiTab() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // 1차: 현재 탭이 이미 Gemini면 그대로 사용
  if (activeTab && activeTab.url && (activeTab.url.startsWith('https://gemini.google.com') || activeTab.url.startsWith('https://aistudio.google.com'))) {
    return activeTab;
  }

  // 2차: 새 탭으로 Gemini 열기
  const newTab = await chrome.tabs.create({ url: 'https://gemini.google.com/app' });

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
$('#btnStart').addEventListener('click', async () => {
  saveState();

  const commonStyle = $('#commonStyle').value.trim();
  const items = [...document.querySelectorAll('.prompt-item')];
  const prompts = items
    .map((el) => ({
      el,
      title: el.querySelector('.item-title').value,
      text: el.querySelector('textarea').value.trim(),
    }))
    .filter((p) => p.text.length > 0);

  if (prompts.length === 0) {
    $('#status').textContent = '⚠ 프롬프트를 하나 이상 입력하세요.';
    return;
  }

  const delay = (parseInt($('#delay').value, 10) || 3) * 1000;

  // Gemini 탭 찾기 또는 이동
  $('#status').textContent = 'Gemini 탭 확인 중...';
  const tab = await getOrOpenGeminiTab();
  await new Promise((r) => setTimeout(r, 1000)); // 페이지 안정화 대기

  $('#btnStart').disabled = true;
  $('#btnStop').disabled = false;

  // 모든 아이템 상태 초기화
  items.forEach((el) => el.classList.remove('done', 'active'));

  // 프롬프트 prefix: 공통 스타일에 따라 분기
  const lowerStyle = (commonStyle || '').toLowerCase();
  const isInfographic = lowerStyle.includes('infographic') || lowerStyle.includes('인포그래픽');
  const prefix = isInfographic
    ? '블로그 포스팅에 삽입할 인포그래픽 썸네일 이미지를 생성해줘. 아래 설명을 따라줘:'
    : '블로그 포스팅에 삽입할 이미지를 생성해줘. 아래 설명을 따라줘:';

  // 큐 데이터를 content script로 전송
  const queue = prompts.map((p) => ({
    combined: prefix + '\n\n' + (commonStyle ? commonStyle + '\n\n' : '') + p.text,
    title: p.title,
  }));

  // 폴더명 자동 생성: Gemini_MMDD_타입_제목
  const folderName = generateFolderName(commonStyle, prompts);

  try {
    await ensureContentScript(tab.id);
    chrome.tabs.sendMessage(tab.id, {
      action: 'startBatch',
      queue,
      delay,
      folderName,
    });
  } catch (err) {
    resetUI(`❌ Content script 주입 실패: ${err.message}`);
  }
});

$('#btnStop').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    try {
      await ensureContentScript(tab.id);
      chrome.tabs.sendMessage(tab.id, { action: 'stopBatch' });
    } catch { /* ignore */ }
  }
  resetUI('중지됨');
});

function resetUI(statusText) {
  $('#btnStart').disabled = false;
  $('#btnStop').disabled = true;
  $('#status').textContent = statusText || '';
}

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
    // 완료 후 모든 텍스트박스 초기화
    $('#commonStyle').value = '';
    promptList.innerHTML = '';
    promptCount = 0;
    addPromptItem();
    chrome.storage.local.remove('batchState');
    resetUI(`✅ 전체 ${msg.total}건 완료`);
  }

  if (msg.type === 'batchError') {
    resetUI(`❌ 오류: ${msg.error}`);
  }

  if (msg.type === 'batchStopped') {
    resetUI('⏹ 중지됨');
  }
});
