/**
 * Gemini Batch Image Generator — Content Script
 *
 * 흐름: 입력창에 프롬프트 입력 → 전송 → 정지버튼(■) 사라짐 대기 → 다음 반복
 */

(() => {
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
    const candidates = document.querySelectorAll(
      '.ql-editor[contenteditable="true"], ' +
      'div[contenteditable="true"][role="textbox"], ' +
      '[contenteditable="true"].text-input-field, ' +
      'rich-textarea [contenteditable="true"], ' +
      'div[contenteditable="true"]'
    );

    let best = null;
    let bestY = -1;
    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      if (rect.height > 0 && rect.width > 0 && rect.bottom > bestY) {
        bestY = rect.bottom;
        best = el;
      }
    }
    return best;
  }

  // ──────────────────────────────────────────
  // 입력창에 텍스트 삽입
  // ──────────────────────────────────────────
  function setInputText(text) {
    const input = getInputBox();
    if (!input) throw new Error('입력창을 찾을 수 없습니다.');

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

    // 폴백: 하단 우측의 아이콘 버튼
    if (!btn) {
      const allButtons = document.querySelectorAll('button');
      const vh = window.innerHeight;
      let bestRight = -1;

      for (const b of allButtons) {
        const rect = b.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.bottom < vh - 100) continue; // 최하단 100px
        if (rect.width > 80) continue; // 작은 버튼만
        if (!b.querySelector('svg, mat-icon')) continue; // 아이콘 버튼만
        // 가장 우측 버튼
        if (rect.right > bestRight) {
          bestRight = rect.right;
          btn = b;
        }
      }
    }

    if (!btn) {
      // 최후의 수단: Enter 키
      const input = getInputBox();
      if (input) {
        input.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true,
        }));
        return;
      }
      throw new Error('전송 버튼을 찾을 수 없습니다.');
    }

    btn.click();
  }

  // ──────────────────────────────────────────
  // 이미지 생성 완료 대기
  // 전략: 정지 버튼(■) 등장 → 소멸 감지
  // ──────────────────────────────────────────
  function isStopButtonVisible() {
    const allButtons = document.querySelectorAll('button');
    const vh = window.innerHeight;

    for (const btn of allButtons) {
      const rect = btn.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.bottom < vh - 100) continue; // 최하단 100px만

      // aria-label로 판별
      const label = (btn.getAttribute('aria-label') || '').toLowerCase();
      if (label.includes('stop') || label.includes('중지') || label.includes('중단') || label.includes('cancel')) {
        return true;
      }

      // mat-icon 텍스트로 판별
      const icon = btn.querySelector('mat-icon');
      if (icon) {
        const iconText = icon.textContent.trim().toLowerCase();
        if (iconText === 'stop' || iconText === 'stop_circle' || iconText === 'cancel') {
          return true;
        }
      }

      // SVG 내부의 rect 요소 (■ 정지 아이콘)
      const svg = btn.querySelector('svg');
      if (svg) {
        const rects = svg.querySelectorAll('rect');
        const paths = svg.querySelectorAll('path');
        if (rects.length > 0 && paths.length === 0) {
          return true;
        }
      }
    }
    return false;
  }

  async function waitForResponseComplete() {
    console.log('[Batch] 응답 완료 대기 시작...');

    // 1단계: 정지 버튼(■) 등장 대기 (= 생성 시작, 최대 20초)
    let stopSeen = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      if (isStopButtonVisible()) {
        stopSeen = true;
        console.log('[Batch] 정지 버튼 감지 — 생성 중');
        break;
      }
      await sleep(300);
    }

    if (!stopSeen) {
      console.log('[Batch] 정지 버튼 미감지, 폴백 대기');
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
        return stableCount >= 5;
      },
      { interval: 1000, timeout: 300000 }
    );

    // 3단계: 추가 안정화
    await sleep(3000);
    console.log('[Batch] 이미지 생성 완료');
  }

  // ──────────────────────────────────────────
  // 이미지 자동 다운로드
  // img src → fetch → blob → dataURL → background.js → chrome.downloads
  // ──────────────────────────────────────────
  let downloadedSrcs = new Set();
  let downloadCounter = 0;
  let downloadFolder = ''; // 배치 시작 시 설정됨

  async function downloadLastImage(title) {
    window.scrollTo(0, document.body.scrollHeight);
    await sleep(1500);

    const allImages = document.querySelectorAll('img');
    const newImages = [];

    for (const img of allImages) {
      const src = img.src || '';
      if (!src) continue;
      if (downloadedSrcs.has(src)) continue;

      const rect = img.getBoundingClientRect();
      if (rect.width < 200 || rect.height < 200) continue;

      newImages.push({ img, src, y: rect.top });
    }

    if (newImages.length === 0) {
      console.log('[Batch] 새 이미지 없음, 스킵');
      return;
    }

    newImages.sort((a, b) => b.y - a.y);

    for (const { src } of newImages) {
      try {
        downloadedSrcs.add(src);
        downloadCounter++;

        const safeName = (title || 'image').replace(/[^a-zA-Z0-9가-힣_-]/g, '_').substring(0, 50);
        const idx = String(downloadCounter - 1).padStart(2, '0');
        const fileName = `${idx}_${safeName}.png`;

        // fetch → blob → dataURL 변환
        const response = await fetch(src);
        const blob = await response.blob();
        const dataUrl = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.readAsDataURL(blob);
        });

        // background.js에 다운로드 요청 (chrome.downloads API 사용)
        chrome.runtime.sendMessage({
          action: 'downloadImage',
          dataUrl,
          fileName,
          folder: downloadFolder,
        });

        console.log('[Batch] 이미지 다운로드:', downloadFolder + '/' + fileName);
        await sleep(500);
      } catch (err) {
        console.log('[Batch] 이미지 다운로드 실패:', err.message);
      }
    }
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

    for (let i = 0; i < queue.length; i++) {
      if (!running) {
        chrome.runtime.sendMessage({ type: 'batchStopped' });
        return;
      }

      const { combined, title } = queue[i];
      const current = i + 1;

      try {
        // 프롬프트 입력
        sendProgress(current, total, title, '프롬프트 입력 중...');
        setInputText(combined);
        await sleep(500);

        // 전송
        sendProgress(current, total, title, '전송 중...');
        await clickSend();

        // 응답 대기
        sendProgress(current, total, title, '이미지 생성 대기 중...');
        await waitForResponseComplete();

        // 이미지 다운로드
        sendProgress(current, total, title, '다운로드 중...');
        await downloadLastImage(title);

        sendProgress(current, total, title, '완료!');

        // 다음 요청 전 딜레이 (마지막 건 제외)
        if (i < queue.length - 1) {
          sendProgress(current, total, title, `${delay / 1000}초 대기 중...`);
          await sleep(delay);
        }
      } catch (err) {
        chrome.runtime.sendMessage({
          type: 'batchError',
          error: `[${current}/${total}] ${title}: ${err.message}`,
        });
        running = false;
        return;
      }
    }

    running = false;
    chrome.runtime.sendMessage({ type: 'batchDone', total });
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
        sendResponse({ ok: false, error: 'already running' });
        return;
      }
      runBatch(msg.queue, msg.delay, msg.folderName);
      sendResponse({ ok: true });
    }

    if (msg.action === 'stopBatch') {
      running = false;
      sendResponse({ ok: true });
    }
  });
})();
