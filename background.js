// 확장프로그램 아이콘 클릭 시 사이드 패널 열기
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// 사이드 패널을 사용자 제스처(아이콘 클릭)로 열 수 있도록 설정
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

// content script에서 보낸 이미지 데이터를 chrome.downloads로 저장
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'downloadImage') {
    const { dataUrl, fileName, folder } = msg;
    const fullPath = folder ? `${folder}/${fileName}` : fileName;

    console.log(`[Background][DOWNLOAD] 다운로드 요청: ${fullPath} (dataUrl 길이: ${dataUrl?.length || 0})`);

    chrome.downloads.download({
      url: dataUrl,
      filename: fullPath,
      saveAs: false,
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        const errMsg = chrome.runtime.lastError.message;
        console.error(`[Background][DOWNLOAD] ❌ 실패: ${fullPath} — ${errMsg}`);
        // popup에 실패 알림
        chrome.runtime.sendMessage({
          type: 'batchLog',
          entry: {
            timestamp: new Date().toISOString(),
            level: 'ERROR',
            category: 'BG-DL',
            message: `다운로드 실패: ${fullPath} — ${errMsg}`,
          },
        }).catch(() => {});
        sendResponse({ ok: false, error: errMsg });
      } else {
        console.log(`[Background][DOWNLOAD] ✅ 성공: ${fullPath} (id: ${downloadId})`);
        chrome.runtime.sendMessage({
          type: 'batchLog',
          entry: {
            timestamp: new Date().toISOString(),
            level: 'INFO',
            category: 'BG-DL',
            message: `다운로드 완료: ${fullPath} (id: ${downloadId})`,
          },
        }).catch(() => {});
        sendResponse({ ok: true, downloadId });
      }
    });

    return true; // 비동기 응답 유지
  }

  // 폴더명으로 다운로드 항목 검색 (Windows \ / 양쪽 대응)
  function searchDownloadsByFolder(folder, callback) {
    // 폴더명에서 정규식 특수문자 이스케이프 후, 경로 구분자를 [/\\]로 대체
    const escaped = folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = escaped + '[/\\\\]';
    chrome.downloads.search({ filenameRegex: regex }, (results) => {
      const completed = (results || []).filter(r => r.state === 'complete');
      callback(completed);
    });
  }

  // 폴더 내 다운로드된 파일 삭제
  if (msg.action === 'deleteDownloads') {
    const folder = msg.folder || '';
    if (!folder) {
      sendResponse({ ok: false });
      return;
    }
    searchDownloadsByFolder(folder, (completed) => {
      let deleted = 0;
      let remaining = completed.length;

      if (remaining === 0) {
        console.log(`[Background][DELETE] 폴더 "${folder}" 내 삭제할 파일 없음`);
        sendResponse({ ok: true, deleted: 0 });
        return;
      }

      completed.forEach(item => {
        chrome.downloads.removeFile(item.id, () => {
          chrome.downloads.erase({ id: item.id }, () => {
            deleted++;
            remaining--;
            if (remaining === 0) {
              console.log(`[Background][DELETE] 폴더 "${folder}" 내 ${deleted}개 파일 삭제 완료`);
              sendResponse({ ok: true, deleted });
            }
          });
        });
      });
    });
    return true;
  }

  // 폴더 내 다운로드된 파일 수 조회
  if (msg.action === 'countDownloads') {
    const folder = msg.folder || '';
    if (!folder) {
      sendResponse({ ok: false, count: 0 });
      return;
    }
    searchDownloadsByFolder(folder, (completed) => {
      console.log(`[Background][COUNT] 폴더 "${folder}" 내 파일: ${completed.length}개`);
      sendResponse({ ok: true, count: completed.length, files: completed.map(r => r.filename) });
    });
    return true;
  }
});
