// 페일 문에서 탭을 닫을 때마다 메모리 정리
//   탭을 닫을 때마다 화면끊김이 좀 있지만 효과는 있음.

// 컴포넌트
const Cc = Components.classes, Ci = Components.interfaces, Cu = Components.utils;
// 메모리 관리자
const memoryManager = Cc['@mozilla.org/memory-reporter-manager;1'].getService(Ci.nsIMemoryReporterManager);
// Services 모듈 가져오기
Cu.import('resource://gre/modules/Services.jsm');

// 탭 닫기 이벤트 핸들러가 붙은 창 목록 (확장 프로그램 비활성화 시 필요)
//   어차피 창이 닫힐 때 제거되므로 굳이 WeakSet는 안 써도 된다.
const attachedWindows = [];

// 이미 열려 있는 모든 창을 순회한다.
function processWindows(callback) {
	const windows = Services.wm.getEnumerator('navigator:browser');
	while(windows.hasMoreElements())
		callback(windows.getNext());
}

// 탭이 닫힐 때 메모리 정리
function freeMemory() {
	// 쓰레기 수집하기
	Services.obs.notifyObservers(null, 'child-gc-request', null);
	Cu.forceGC();

	// 메모리 사용량 최소화 (minimise memory usage)
	Services.obs.notifyObservers(null, 'child-mmu-request', null);
	memoryManager.minimizeMemoryUsage(() => {});

	// Services.prompt.alert(null, null, '메모리 정리 완료');
}

// 탭 닫기 이벤트 수신기 부착
function attachHandler(domWindow) {
	// 내비게이터 창에만 적용
	if(domWindow.document.documentElement.getAttribute('windowtype') !== 'navigator:browser') return;

	// 탭 닫기 감지기 붙이기
	domWindow.gBrowser.tabContainer.addEventListener('TabClose', freeMemory);

	// 등록된 창 배열에 등록
	attachedWindows.push(domWindow);
}

// 탭 닫기 이벤트 수신기 해제
function detachHandler(domWindow) {
	// 내비게이터 창에만 적용
	if(domWindow.document.documentElement.getAttribute('windowtype') !== 'navigator:browser') return;

	// 탭 닫기 감지기 해제
	domWindow.gBrowser.tabContainer.removeEventListener('TabClose', freeMemory);

	// 등록된 창 배열에서 해제 (창을 일만 개 켜 놓을 거 아니니까 선형탐색도 괜찮다.)
	const index = attachedWindows.findIndex(item => item === domWindow);
	if(index !== -1)
		attachedWindows.splice(index, 1);
}

// 창이 열릴 때와 닫힐 때 감지
const windowListener = {
	// 새 창에 탭 닫기 이벤트 감지기 붙이기
	onOpenWindow(xulWindow) {
		const domWindow = xulWindow.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIDOMWindow);
		domWindow.addEventListener('load', function onLoad() {
			// 일회성 이벤트 (로드 후 해제)
			domWindow.removeEventListener('load', onLoad);
			// 탭 닫기 이벤트 수신기 부착
			attachHandler(domWindow);
		});
	},

	// 창이 닫히면 탭 닫기 감지기 해제
	onCloseWindow(xulWindow) {
		const domWindow = xulWindow.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIDOMWindow);
		// 내비게이터 창에만 적용
		if(domWindow.document.documentElement.getAttribute('windowtype') !== 'navigator:browser') return;
		// 탭 닫기 이벤트 수신기 해제
		detachHandler(domWindow);
		// 창이 닫힐 때도 메모리 정리. 탭이 많았어도 창이 닫힐 땐 여기서 한 번만 호출된다.
		freeMemory();
	},
};

// 확장 프로그램이 활성화될 때
function startup(data, reason) {
	// 기존 창에 탭 닫기 이벤트 수신기 붙이기
	processWindows(attachHandler);
	// 창 열기 이벤트 감지기 등록
	Services.wm.addListener(windowListener);
}

// 확장 프로그램이 비활성화될 때
function shutdown(data, reason) {
	// 창 열기 이벤트 감지기 해제
	Services.wm.removeListener(windowListener);

	// 이미 붙어 있던 탭 닫기 감지기 해제
	for(var domWindow of attachedWindows)
		domWindow.gBrowser.tabContainer.removeEventListener('TabClose', freeMemory);
}

function install() {}

function uninstall() {}
