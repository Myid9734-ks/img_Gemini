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

    chrome.downloads.download({
      url: dataUrl,
      filename: fullPath,
      saveAs: false,
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ ok: true, downloadId });
      }
    });

    return true; // 비동기 응답 유지
  }
});
