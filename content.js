/**
 * Gemini Batch Image Generator — Content Script
 *
 * 흐름: 입력창에 프롬프트 입력 → 전송 → 정지버튼(■) 사라짐 대기 → 다음 반복
 */

(() => {
  // ──────────────────────────────────────────
  // 로깅 시스템
  // ──────────────────────────────────────────
  const LOG_HISTORY = [];

  function log(level, category, message, data = null) {
    const timestamp = new Date().toISOString();
    const entry = { timestamp, level, category, message, data };
    LOG_HISTORY.push(entry);

    const prefix = `[Batch][${level}][${category}]`;
    const style = level === 'ERROR' ? 'color:red;font-weight:bold'
                : level === 'WARN'  ? 'color:orange;font-weight:bold'
                : level === 'INFO'  ? 'color:#4a9eff'
                : 'color:gray';

    if (data) {
      console.log(`%c${prefix} ${message}`, style, data);
    } else {
      console.log(`%c${prefix} ${message}`, style);
    }

    // popup에도 로그 전달
    try {
      chrome.runtime.sendMessage({
        type: 'batchLog',
        entry,
      });
    } catch { /* popup 닫혀있으면 무시 */ }
  }

  // ──────────────────────────────────────────
  // 유틸리티
  // ──────────────────────────────────────────
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function queryFirst(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function waitUntil(condFn, { interval = 1000, timeout = 300000 } = {}) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (condFn()) return resolve(true);
        if (Date.now() - start > timeout) return reject(new Error('대기 시간 초과 (5분)'));
        setTimeout(check, interval);
      };
      check();
    });
  }

  // ──────────────────────────────────────────
  // 입력창 찾기
  // ──────────────────────────────────────────
  function getInputBox() {
    // 1순위: ql-editor (Gemini 기본 입력창) — ql-clipboard 제외
    const qlEditor = document.querySelector('.ql-editor[contenteditable="true"]:not(.ql-clipboard)');
    if (qlEditor) {
      log('DEBUG', 'INPUT', `입력창 탐색: ql-editor 직접 선택`, { tag: qlEditor.tagName, class: qlEditor.className });
      return qlEditor;
    }

    // 2순위: 기타 contenteditable 입력창
    const candidates = document.querySelectorAll(
      'div[contenteditable="true"][role="textbox"], ' +
      '[contenteditable="true"].text-input-field, ' +
      'rich-textarea [contenteditable="true"], ' +
      'div[contenteditable="true"]'
    );

    let best = null;
    let bestY = -1;
    for (const el of candidates) {
      // ql-clipboard, hidden 요소 제외
      if (el.classList.contains('ql-clipboard')) continue;
      if (el.offsetParent === null) continue;

      const rect = el.getBoundingClientRect();
      // 활성 탭이면 rect 사용, 비활성 탭이면 offsetTop 사용
      const y = (rect.height > 0) ? rect.bottom : (el.offsetTop || 0);
      if (y > bestY) {
        bestY = y;
        best = el;
      }
    }

    log('DEBUG', 'INPUT', `입력창 탐색: ${candidates.length}개 후보, 선택=${best ? 'OK' : 'NONE'}`, best ? { tag: best.tagName, class: best.className } : null);
    return best;
  }

  // ──────────────────────────────────────────
  // 입력창에 텍스트 삽입
  // ──────────────────────────────────────────
  function setInputText(text) {
    const input = getInputBox();
    if (!input) {
      log('ERROR', 'INPUT', '입력창을 찾을 수 없습니다.');
      throw new Error('입력창을 찾을 수 없습니다.');
    }

    input.focus();
    input.innerHTML = '';

    const lines = text.split('\n');
    lines.forEach((line) => {
      const p = document.createElement('p');
      p.textContent = line || '\u200B';
      input.appendChild(p);
    });

    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    log('INFO', 'INPUT', `텍스트 입력 완료 (${lines.length}줄, ${text.length}자)`, { preview: text.substring(0, 100) + '...' });
  }

  // ──────────────────────────────────────────
  // 전송 버튼 클릭
  // ──────────────────────────────────────────
  async function clickSend() {
    await sleep(800);

    const sendSelectors = [
      'button[aria-label="Send message"]',
      'button[aria-label="메시지 보내기"]',
      'button[aria-label="보내기"]',
      'button[aria-label="Submit"]',
      'button.send-button',
    ];

    let btn = queryFirst(sendSelectors);
    let method = btn ? 'aria-label' : null;

    // 폴백: 하단 우측의 아이콘 버튼
    if (!btn) {
      const allButtons = document.querySelectorAll('button');
      const vh = window.innerHeight;
      let bestRight = -1;

      // 제외할 aria-label 패턴
      const excludeLabels = ['임시', '채팅', '알림', 'notification', 'temporary', 'menu', '메뉴', '설정', 'setting', '더보기', 'more'];

      for (const b of allButtons) {
        const rect = b.getBoundingClientRect();
        // 활성 탭: rect 기반 필터
        if (rect.height > 0) {
          if (rect.bottom < vh - 100) continue;
          if (rect.width > 80) continue;
        } else {
          // 비활성 탭: hidden 제외, 작은 버튼만
          if (b.offsetParent === null) continue;
          if (b.offsetWidth > 80) continue;
        }
        if (!b.querySelector('svg, mat-icon')) continue;

        // 전송과 무관한 버튼 제외
        const label = (b.getAttribute('aria-label') || '').toLowerCase();
        if (excludeLabels.some(ex => label.includes(ex))) continue;

        const right = rect.right || b.offsetLeft || 0;
        if (right > bestRight) {
          bestRight = right;
          btn = b;
        }
      }
      if (btn) method = 'fallback-icon-button';
    }

    if (!btn) {
      // 최후의 수단: Enter 키
      const input = getInputBox();
      if (input) {
        input.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true,
        }));
        log('WARN', 'SEND', 'Enter 키로 전송 (버튼 미발견)');
        return;
      }
      log('ERROR', 'SEND', '전송 버튼을 찾을 수 없습니다.');
      throw new Error('전송 버튼을 찾을 수 없습니다.');
    }

    btn.click();
    log('INFO', 'SEND', `전송 버튼 클릭 (방법: ${method})`, { ariaLabel: btn.getAttribute('aria-label'), disabled: btn.disabled });
  }

  // ──────────────────────────────────────────
  // 이미지 생성 완료 대기
  // 전략: 정지 버튼(■) 등장 → 소멸 감지
  // ──────────────────────────────────────────
  function isStopButtonVisible() {
    const allButtons = document.querySelectorAll('button');
    const vh = window.innerHeight;

    for (const btn of allButtons) {
      // hidden 제외
      if (btn.offsetParent === null) continue;

      // 위치 필터: 활성 탭이면 하단 영역만, 비활성이면 rect가 0이므로 스킵
      const rect = btn.getBoundingClientRect();
      const isActiveTab = rect.height > 0;
      if (isActiveTab && rect.bottom < vh - 150) continue;

      // aria-label 기반 감지
      const label = (btn.getAttribute('aria-label') || '').toLowerCase();
      if (label.includes('stop') || label.includes('중지') || label.includes('중단')) {
        // '중지' 포함하지만 관련없는 버튼 제외
        if (label.includes('임시') || label.includes('채팅') || label.includes('알림')) continue;
        return true;
      }

      // mat-icon 텍스트 기반 감지
      const icon = btn.querySelector('mat-icon');
      if (icon) {
        const iconText = icon.textContent.trim().toLowerCase();
        if (iconText === 'stop' || iconText === 'stop_circle') {
          return true;
        }
      }

      // SVG 내부 rect 요소 (■ 정지 아이콘) — 하단 영역에서만
      if (isActiveTab) {
        const svg = btn.querySelector('svg');
        if (svg) {
          const rects = svg.querySelectorAll('rect');
          const paths = svg.querySelectorAll('path');
          if (rects.length > 0 && paths.length === 0) {
            return true;
          }
        }
      }
    }
    return false;
  }

  // ──────────────────────────────────────────
  // Gemini 응답에서 에러/경고 텍스트 감지
  // ──────────────────────────────────────────
  function detectResponseError() {
    // 마지막 응답 영역에서 에러 메시지 탐색
    const responseBlocks = document.querySelectorAll(
      'message-content, .response-container, .model-response-text, ' +
      '[data-message-author-role="model"], .markdown-main-panel'
    );

    const lastBlock = responseBlocks.length > 0 ? responseBlocks[responseBlocks.length - 1] : null;
    if (!lastBlock) return null;

    const text = lastBlock.innerText || '';
    const lower = text.toLowerCase();

    // 알려진 에러 패턴들
    const errorPatterns = [
      { pattern: /이미지를 생성할 수 없/, type: 'GENERATION_REFUSED' },
      { pattern: /이미지 생성.*실패/, type: 'GENERATION_FAILED' },
      { pattern: /안전.*정책|정책.*위반|콘텐츠.*정책/, type: 'POLICY_VIOLATION' },
      { pattern: /능력을 벗어나|능력 밖/, type: 'CAPABILITY_REFUSED' },
      { pattern: /텍스트 기반 AI/, type: 'TEXT_ONLY_MODEL' },
      { pattern: /i can't generate|i cannot generate|unable to generate/i, type: 'GENERATION_REFUSED_EN' },
      { pattern: /i can't edit images|i cannot edit images/i, type: 'EDIT_REFUSED_EN' },
      { pattern: /i('m| am) a text[- ]based/i, type: 'TEXT_ONLY_MODEL_EN' },
      { pattern: /beyond my (capabilities|ability)/i, type: 'CAPABILITY_REFUSED_EN' },
      { pattern: /safety policy|content policy|violat/i, type: 'POLICY_VIOLATION_EN' },
      { pattern: /오류가 발생|something went wrong|error occurred/i, type: 'GENERAL_ERROR' },
      { pattern: /다시 시도|try again/i, type: 'RETRY_SUGGESTED' },
      { pattern: /할 수 없습니다|못합니다/i, type: 'CANNOT_DO' },
    ];

    for (const { pattern, type } of errorPatterns) {
      if (pattern.test(text)) {
        return { type, text: text.substring(0, 300) };
      }
    }

    return null;
  }

  async function waitForResponseComplete() {
    log('INFO', 'WAIT', '응답 완료 대기 시작...');
    const waitStart = Date.now();

    // 1단계: 정지 버튼(■) 등장 대기 (= 생성 시작, 최대 20초)
    let stopSeen = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      if (isStopButtonVisible()) {
        stopSeen = true;
        log('INFO', 'WAIT', `정지 버튼 감지 — 생성 중 (${((Date.now() - t0) / 1000).toFixed(1)}초 후)`);
        break;
      }
      await sleep(300);
    }

    if (!stopSeen) {
      log('WARN', 'WAIT', '정지 버튼 미감지 (20초), 폴백 대기 진입');
    }

    // 2단계: 정지 버튼 소멸 대기 (= 생성 완료, 5초 연속 미감지)
    let stableCount = 0;
    await waitUntil(
      () => {
        if (isStopButtonVisible()) {
          stableCount = 0;
          return false;
        }
        stableCount++;
        if (stableCount === 1) {
          log('DEBUG', 'WAIT', '정지 버튼 소멸 감지, 안정화 카운트 시작');
        }
        return stableCount >= 5;
      },
      { interval: 1000, timeout: 300000 }
    );

    // 3단계: 추가 안정화
    await sleep(3000);

    const elapsed = ((Date.now() - waitStart) / 1000).toFixed(1);
    log('INFO', 'WAIT', `응답 대기 완료 (총 ${elapsed}초 소요)`);

    // 4단계: 응답 에러 감지
    const responseError = detectResponseError();
    if (responseError) {
      log('WARN', 'WAIT', `응답에서 에러 감지: ${responseError.type}`, { text: responseError.text });
    }

    return { stopSeen, elapsed, responseError };
  }

  // ──────────────────────────────────────────
  // 이미지 자동 다운로드
  // ──────────────────────────────────────────
  let downloadedSrcs = new Set();
  let downloadCounter = 0;
  let downloadFolder = '';

  async function downloadLastImage(title) {
    log('INFO', 'DOWNLOAD', `이미지 다운로드 시도: "${title}"`);

    // 스크롤 시도 (비활성 탭에서는 무시될 수 있으나 해롭지 않음)
    try { window.scrollTo(0, document.body.scrollHeight); } catch {}
    await sleep(1500);

    // 페이지 내 모든 이미지 현황 스캔 (naturalWidth/Height 사용 — 비활성 탭에서도 동작)
    const allImages = document.querySelectorAll('img');
    const imageStats = { total: allImages.length, tooSmall: 0, alreadyDownloaded: 0, noSrc: 0, candidates: 0 };
    const newImages = [];

    for (const img of allImages) {
      const src = img.src || '';
      if (!src) { imageStats.noSrc++; continue; }
      if (downloadedSrcs.has(src)) { imageStats.alreadyDownloaded++; continue; }

      // naturalWidth/Height: 이미지 고유 크기 (렌더링 상태 무관, 비활성 탭에서도 정확)
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w < 200 || h < 200) { imageStats.tooSmall++; continue; }

      imageStats.candidates++;
      // DOM 순서(인덱스)를 y 대신 사용
      const domIndex = Array.from(allImages).indexOf(img);
      newImages.push({ img, src, domIndex, width: w, height: h });
    }

    log('INFO', 'DOWNLOAD', `이미지 스캔 결과`, imageStats);

    if (newImages.length === 0) {
      log('WARN', 'DOWNLOAD', `⚠ 새 이미지 없음! (전체 ${allImages.length}개 중 후보 0개)`, {
        이미_다운로드: imageStats.alreadyDownloaded,
        너무_작음: imageStats.tooSmall,
        src_없음: imageStats.noSrc,
      });
      return { downloaded: false, reason: 'NO_NEW_IMAGE', stats: imageStats };
    }

    // DOM 순서 역순 (가장 마지막 = 최신 이미지)
    newImages.sort((a, b) => b.domIndex - a.domIndex);

    const downloadResults = [];
    for (const { src, width, height } of newImages) {
      try {
        downloadedSrcs.add(src);
        downloadCounter++;

        const safeName = (title || 'image').replace(/[^a-zA-Z0-9가-힣_-]/g, '_').substring(0, 50);
        const idx = String(downloadCounter - 1).padStart(2, '0');
        const fileName = `${idx}_${safeName}.png`;

        log('DEBUG', 'DOWNLOAD', `이미지 fetch 시작: ${fileName} (${width}x${height})`, { src: src.substring(0, 100) });

        const response = await fetch(src);
        if (!response.ok) {
          log('ERROR', 'DOWNLOAD', `fetch 실패: HTTP ${response.status}`, { src: src.substring(0, 100) });
          downloadResults.push({ fileName, success: false, error: `HTTP ${response.status}` });
          continue;
        }

        const blob = await response.blob();
        log('DEBUG', 'DOWNLOAD', `blob 변환 완료: ${(blob.size / 1024).toFixed(1)}KB, type=${blob.type}`);

        const dataUrl = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.readAsDataURL(blob);
        });

        chrome.runtime.sendMessage({
          action: 'downloadImage',
          dataUrl,
          fileName,
          folder: downloadFolder,
        });

        log('INFO', 'DOWNLOAD', `✅ 다운로드 요청: ${downloadFolder}/${fileName} (${(blob.size / 1024).toFixed(1)}KB)`);
        downloadResults.push({ fileName, success: true, size: blob.size });
        await sleep(500);
      } catch (err) {
        log('ERROR', 'DOWNLOAD', `다운로드 실패: ${err.message}`, { src: src.substring(0, 100) });
        downloadResults.push({ success: false, error: err.message });
      }
    }

    return { downloaded: true, results: downloadResults, stats: imageStats };
  }

  // ──────────────────────────────────────────
  // "이미지 만들기" 모드 활성화
  // ──────────────────────────────────────────
  async function activateImageMode() {
    // 이미 이미지 모드인지 확인 — 입력창 근처에 "이미지" 칩/뱃지가 있으면 스킵
    const inputBox = getInputBox();
    if (inputBox) {
      const inputContainer = inputBox.closest('footer, .input-area, [class*="input-wrapper"]') || inputBox.parentElement?.parentElement?.parentElement;
      if (inputContainer) {
        const chipTexts = inputContainer.querySelectorAll('[class*="chip"], [class*="badge"], [class*="pill"], [class*="tag"]');
        for (const chip of chipTexts) {
          const text = (chip.textContent || '').trim();
          if (text === '이미지' || text === 'Image') {
            log('DEBUG', 'IMAGE_MODE', '이미 이미지 모드 활성화 상태 (칩 감지)', { text, class: chip.className.substring(0, 80) });
            return true;
          }
        }
      }
    }

    // 페이지 내 모든 버튼 정보 로깅 (디버그용)
    const allButtons = document.querySelectorAll('button');
    const btnInfo = [];
    allButtons.forEach((btn, i) => {
      const label = btn.getAttribute('aria-label') || '';
      const text = btn.textContent.trim().substring(0, 30);
      const icon = btn.querySelector('mat-icon');
      const iconText = icon ? icon.textContent.trim() : '';
      const visible = btn.offsetParent !== null;
      const classes = btn.className.substring(0, 60);
      if (visible) {
        btnInfo.push({ i, label, text, iconText, classes });
      }
    });
    log('DEBUG', 'IMAGE_MODE', `페이지 내 보이는 버튼 ${btnInfo.length}개:`, btnInfo);

    // + 버튼 찾기 (aria-label="업로드 및 도구")
    let plusBtn = null;
    for (const btn of allButtons) {
      if (btn.offsetParent === null) continue;
      const label = (btn.getAttribute('aria-label') || '').toLowerCase();

      if (label.includes('업로드') || label.includes('도구') || label.includes('upload') || label.includes('tools')) {
        plusBtn = btn;
        log('DEBUG', 'IMAGE_MODE', `+ 버튼 발견: "${btn.getAttribute('aria-label')}"`, { class: btn.className.substring(0, 60) });
        break;
      }
    }

    if (!plusBtn) {
      log('WARN', 'IMAGE_MODE', '+ 버튼(업로드 및 도구)을 찾을 수 없음 — 이미지 모드 스킵');
      return false;
    }

    // + 버튼 클릭
    plusBtn.click();
    log('DEBUG', 'IMAGE_MODE', '+ 버튼 클릭');
    await sleep(800);

    // 메뉴 열린 후 — "이미지 만들기" 텍스트를 가진 gem-list-item 찾기
    const gemItems = document.querySelectorAll('gem-list-item, [role="menuitemcheckbox"], [role="menuitem"], toolbox-drawer-item');
    let imageMenuItem = null;

    for (const el of gemItems) {
      const text = (el.textContent || '').trim();
      if (text.includes('이미지 만들기') || text.includes('Create image')) {
        imageMenuItem = el;
        log('DEBUG', 'IMAGE_MODE', `메뉴 항목 발견: "${text}"`, { tag: el.tagName, role: el.getAttribute('role') });
        break;
      }
    }

    if (!imageMenuItem) {
      log('WARN', 'IMAGE_MODE', '"이미지 만들기" 메뉴를 찾을 수 없음');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(300);
      return false;
    }

    // gem-list-item은 .click()이 안 먹힐 수 있으므로 마우스 이벤트로 클릭
    imageMenuItem.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    imageMenuItem.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    imageMenuItem.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    imageMenuItem.click();
    log('INFO', 'IMAGE_MODE', '✅ "이미지 만들기" 클릭 완료', { tag: imageMenuItem.tagName });
    await sleep(1500);

    // 내부의 mat-list-item도 클릭 시도
    const inner = imageMenuItem.querySelector('mat-list-item') || imageMenuItem.querySelector('[class*="list-item"]');
    if (inner) {
      inner.click();
      log('DEBUG', 'IMAGE_MODE', '내부 mat-list-item도 클릭', { tag: inner.tagName });
      await sleep(500);
    }

    return true;
  }

  // ──────────────────────────────────────────
  // 배치 실행
  // ──────────────────────────────────────────
  let running = false;

  function sendProgress(current, total, title, state) {
    chrome.runtime.sendMessage({
      type: 'batchProgress',
      current,
      total,
      title,
      state,
    });
  }

  async function runBatch(queue, delay, folderName) {
    running = true;
    downloadCounter = 0;
    downloadedSrcs.clear();
    downloadFolder = folderName || '';
    const total = queue.length;
    const batchStartTime = Date.now();

    log('INFO', 'BATCH', `========== 배치 시작 ==========`);
    log('INFO', 'BATCH', `총 ${total}건, 간격 ${delay / 1000}초, 폴더: ${folderName}`);
    log('INFO', 'BATCH', `페이지 URL: ${window.location.href}`);
    log('INFO', 'BATCH', `User-Agent: ${navigator.userAgent}`);

    const batchResults = [];

    for (let i = 0; i < queue.length; i++) {
      if (!running) {
        log('WARN', 'BATCH', `사용자 중지 (${i}/${total} 완료)`);
        chrome.runtime.sendMessage({ type: 'batchStopped' });
        return;
      }

      const { combined, title } = queue[i];
      const current = i + 1;
      const itemStart = Date.now();
      const result = { index: current, title, success: false, steps: {} };

      log('INFO', 'BATCH', `────── [${current}/${total}] "${title}" 시작 ──────`);
      log('DEBUG', 'BATCH', `프롬프트 전문 (${combined.length}자):`, { fullText: combined });

      try {
        // 0. "이미지 만들기" 모드 활성화 (최대 3회 시도)
        sendProgress(current, total, title, '이미지 모드 활성화...');
        let imageMode = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          imageMode = await activateImageMode();
          if (imageMode) break;
          log('WARN', 'BATCH', `이미지 모드 활성화 실패 — 재시도 ${attempt + 2}/3`);
          await sleep(1000);
        }
        result.steps.imageMode = imageMode ? 'OK' : 'FAILED';

        // 프롬프트 전송 → 응답 대기 → 다운로드 (실패 시 최대 3회 재시도)
        const MAX_ITEM_RETRIES = 3;
        let dlResult = null;
        let waitResult = null;

        for (let itemRetry = 0; itemRetry < MAX_ITEM_RETRIES; itemRetry++) {
          if (itemRetry > 0) {
            log('WARN', 'BATCH', `[${current}/${total}] "${title}" 이미지 없음 — 같은 프롬프트 재전송 (${itemRetry + 1}/${MAX_ITEM_RETRIES})`);
            sendProgress(current, total, title, `🔄 재전송 ${itemRetry + 1}/${MAX_ITEM_RETRIES}...`);
            await sleep(2000);

            // 재전송 전 이미지 모드 재활성화
            await activateImageMode();
          }

          // 1. 프롬프트 입력
          sendProgress(current, total, title, '프롬프트 입력 중...');
          setInputText(combined);
          result.steps.input = 'OK';
          await sleep(500);

          // 2. 전송
          sendProgress(current, total, title, '전송 중...');
          await clickSend();
          result.steps.send = 'OK';

          // 3. 응답 대기
          sendProgress(current, total, title, '이미지 생성 대기 중...');
          waitResult = await waitForResponseComplete();
          result.steps.wait = waitResult;

          // 4. 이미지 다운로드
          sendProgress(current, total, title, '다운로드 중...');
          dlResult = await downloadLastImage(title);
          result.steps.download = dlResult;

          // 성공하면 루프 탈출
          if (dlResult.downloaded && dlResult.results && dlResult.results.some(r => r.success)) {
            break;
          }

          // 마지막 시도가 아니면 재시도 로그
          if (itemRetry < MAX_ITEM_RETRIES - 1) {
            log('WARN', 'BATCH', `[${current}/${total}] 이미지 미생성 (시도 ${itemRetry + 1}/${MAX_ITEM_RETRIES})`, { reason: dlResult.reason });
          }
        }

        // 5. 결과 판정
        if (dlResult.downloaded && dlResult.results && dlResult.results.some(r => r.success)) {
          result.success = true;
          result.verdict = 'IMAGE_DOWNLOADED';
        } else if (waitResult.responseError) {
          result.success = false;
          result.verdict = `GEMINI_ERROR: ${waitResult.responseError.type}`;
        } else if (!dlResult.downloaded) {
          result.success = false;
          result.verdict = `NO_IMAGE: ${dlResult.reason}`;
        } else {
          result.success = false;
          result.verdict = 'DOWNLOAD_ALL_FAILED';
        }

        const elapsed = ((Date.now() - itemStart) / 1000).toFixed(1);
        result.elapsed = elapsed;

        const icon = result.success ? '✅' : '❌';
        sendProgress(current, total, title, `${icon} ${result.verdict} (${elapsed}초)`);
        log(result.success ? 'INFO' : 'WARN', 'BATCH', `${icon} [${current}/${total}] "${title}" → ${result.verdict} (${elapsed}초)`);

        // 다음 요청 전 딜레이 (마지막 건 제외)
        if (i < queue.length - 1) {
          sendProgress(current, total, title, `${delay / 1000}초 대기 중...`);
          await sleep(delay);
        }
      } catch (err) {
        const elapsed = ((Date.now() - itemStart) / 1000).toFixed(1);
        result.success = false;
        result.verdict = `EXCEPTION: ${err.message}`;
        result.elapsed = elapsed;

        log('ERROR', 'BATCH', `❌ [${current}/${total}] "${title}" 예외 발생: ${err.message}`, { stack: err.stack });

        chrome.runtime.sendMessage({
          type: 'batchError',
          error: `[${current}/${total}] ${title}: ${err.message}`,
        });
        running = false;

        batchResults.push(result);
        logBatchSummary(batchResults, total);
        return;
      }

      batchResults.push(result);
    }

    running = false;
    const totalElapsed = ((Date.now() - batchStartTime) / 1000).toFixed(1);
    log('INFO', 'BATCH', `배치 총 소요시간: ${totalElapsed}초`);
    logBatchSummary(batchResults, total);
    const succeeded = batchResults.filter(r => r.success).length;
    const failed = batchResults.filter(r => !r.success).length;
    chrome.runtime.sendMessage({ type: 'batchDone', total, succeeded, failed });
  }

  // ──────────────────────────────────────────
  // 배치 결과 요약 로그
  // ──────────────────────────────────────────
  function logBatchSummary(results, total) {
    const succeeded = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    log('INFO', 'SUMMARY', `========== 배치 결과 요약 ==========`);
    log('INFO', 'SUMMARY', `전체: ${total}건 | 실행: ${results.length}건 | 성공: ${succeeded}건 | 실패: ${failed}건`);

    results.forEach(r => {
      const icon = r.success ? '✅' : '❌';
      log('INFO', 'SUMMARY', `  ${icon} [${r.index}] "${r.title}" → ${r.verdict} (${r.elapsed}초)`);
    });

    if (failed > 0) {
      log('WARN', 'SUMMARY', `실패 항목 상세:`);
      results.filter(r => !r.success).forEach(r => {
        log('WARN', 'SUMMARY', `  ❌ [${r.index}] "${r.title}"`, r.steps);
      });
    }

    log('INFO', 'SUMMARY', `===================================`);

    // 전체 로그를 popup으로 전달
    chrome.runtime.sendMessage({
      type: 'batchSummary',
      summary: { total, executed: results.length, succeeded, failed, results },
    });
  }

  // ──────────────────────────────────────────
  // 메시지 리스너
  // ──────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'ping') {
      sendResponse({ ok: true });
      return;
    }

    if (msg.action === 'startBatch') {
      if (running) {
        log('WARN', 'MSG', '이전 배치 강제 중지 후 새 배치 시작');
        running = false;
        // 약간 대기 후 시작
        setTimeout(() => {
          log('INFO', 'MSG', 'startBatch 수신', { queueLength: msg.queue?.length, delay: msg.delay, folder: msg.folderName });
          runBatch(msg.queue, msg.delay, msg.folderName);
        }, 300);
        sendResponse({ ok: true });
        return;
      }
      log('INFO', 'MSG', 'startBatch 수신', { queueLength: msg.queue?.length, delay: msg.delay, folder: msg.folderName });
      runBatch(msg.queue, msg.delay, msg.folderName);
      sendResponse({ ok: true });
    }

    if (msg.action === 'stopBatch') {
      log('INFO', 'MSG', 'stopBatch 수신');
      running = false;
      sendResponse({ ok: true });
    }

    if (msg.action === 'getLogHistory') {
      sendResponse({ logs: LOG_HISTORY });
    }
  });
})();
