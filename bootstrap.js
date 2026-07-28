// 컴포넌트 별칭
const { classes: Cc, interfaces: Ci, utils: Cu } = Components;
// 메모리 관리자
const memoryManager = Cc['@mozilla.org/memory-reporter-manager;1'].getService(Ci.nsIMemoryReporterManager);
// 운영체제 정보
const runtime = Cc["@mozilla.org/xre/app-info;1"].getService(Ci.nsIXULRuntime);
// Services 모듈 가져오기
Cu.import('resource://gre/modules/Services.jsm');
// Windows API 직접 호출
Cu.import("resource://gre/modules/ctypes.jsm");

// 설정 분기
const branch = 'extensions.free_memory_on_close.';
const prefBranch = Services.prefs.getBranch(branch);

// Windows API 라이브러리 (startup에서 불러옴, 코틀린같은 late init val이 불가능해서 어쩔 수 없이 var)
var kernel32 = null;
var psapi = null;

// Windows API 함수 (startup에서 불러옴)
var GetCurrentProcess = null;
var EmptyWorkingSet = null;

// 탭 닫기 이벤트 핸들러가 붙은 창 목록 (확장 프로그램 비활성화 시 필요)
//   어차피 창이 닫힐 때 제거되므로 굳이 WeakSet는 안 써도 된다.
const attachedWindows = [];

// 페이지 언로드 이벤트를 감지할 창 모음
const openPages = {};

// 실행할 메모리 정리 타이머
var freeTask = null;
var freeTaskRunning = false;

// 열려 있는 모든 창을 순회한다.
function processWindows(callback) {
	const windows = Services.wm.getEnumerator('navigator:browser');
	while(windows.hasMoreElements())
		callback(windows.getNext());
}

// XPCOM에서는 setTimeout이 없음 (일반 페이지에서는 가능)
function setTimeout(callback, delay, ...args) {
	const timer = Cc['@mozilla.org/timer;1'].createInstance(Ci.nsITimer);
	timer.initWithCallback({
		notify(timer) {
			callback(...args);
		}
	}, delay, Ci.nsITimer.TYPE_ONE_SHOT);
	return timer;
}

// promise판 sleep
function timeout(delay) {
	const timer = Cc['@mozilla.org/timer;1'].createInstance(Ci.nsITimer);
	return new Promise((resolve, reject) => timer.initWithCallback({
		notify(timer) {
			resolve();
		}
	}, delay, Ci.nsITimer.TYPE_ONE_SHOT));
}

// 메모리 정리의 promise판
function minimizeMemoryUsage() {
	return new Promise((resolve, reject) => memoryManager.minimizeMemoryUsage(() => resolve()));
}

// 프로세스 작업 집합에서 페이지를 비운다.
function emptyWorkingSet() {
	// 현재 프로세스 핸들을 가져온다.
	const hProcess = GetCurrentProcess?.();

	// GetCurrentProcess 함수가 로딩되지 않았거나 콜을 실패하면 false 반환
	if(!hProcess) return false;

	// EmptyWorkingSet을 호출하고 성공하면 true 반환
	return EmptyWorkingSet?.(hProcess) ?? false;
}

// 탭이 닫힐 때 메모리 정리
function freeMemory() {
	// 이미 메모리 정리 중이라면 새로 안 함
	if(freeTaskRunning) return;

	// 메모리 정리가 이미 예약돼있다면 취소하고 새로 미룬다.
	freeTask?.cancel();

	freeTask = setTimeout(async () => {
		freeTaskRunning = true;

		// 쓰레기 수집
		if(Services.prefs.getBoolPref(branch + 'gc')) {
			Services.obs.notifyObservers(null, 'child-gc-request', null);
			Cu.forceGC();
		}

		// 메모리 사용량 최소화 (minimise memory usage)
		if(Services.prefs.getBoolPref(branch + 'minimize_memory_usage')) {
			Services.obs.notifyObservers(null, 'child-mmu-request', null);
			await minimizeMemoryUsage();
		}

		// 작업 집합 정리
		if(Services.prefs.getBoolPref(branch + 'empty_working_set')) {
			emptyWorkingSet();
		}

		/* Services.prompt.alert(null, null, '메모리 정리 완료'); */

		// 작업 초기화
		freeTask = null;
		freeTaskRunning = false;
	}, Services.prefs.getIntPref(branch + 'free_delay'));  // 탭 닫힘 애니메이션을 재생하기 위해 1초 뒤 정리 (그냥 눈속임)
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

// 붙어 있던 모든 탭 닫기 감지기 해제
function detachAllHandlers() {
	for(const domWindow of attachedWindows)
		domWindow.gBrowser.tabContainer.removeEventListener('TabClose', freeMemory);
	attachedWindows.length = 0;
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

// 페이지가 로드될 때를 감지
const createObserver = {
	observe(subject, topic, data) {
		// DOM 창이 아니면 건너뛰기
		if(!(subject instanceof Ci.nsIDOMWindow)) return;

		// '웹' 창이 아니면 건너뛰기
		try {
			subject.QueryInterface(Ci.nsIDOMChromeWindow);
			return;
		} catch(e) {}

		// top-level이 아닌 페이지는 건너뛰기
		if(subject !== subject.top) return;

		// 내부 페이지는 건너뛰기
		const uri = subject.document.documentURI;
		if(!uri || uri.startsWith("about:") || uri.startsWith("chrome:") || uri.startsWith("resource:")) return;

		// 맵에 등록
		const id = subject.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIDOMWindowUtils).currentInnerWindowID;
		openPages[id] = uri;

		/* console.log(`[Freemem] ${uri}(${id}) 열림`); */
	},

	register() {
		Services.obs.addObserver(this, 'content-document-global-created', false);
	},

	unregister() {
		Services.obs.removeObserver(this, 'content-document-global-created');
	},
};

// 페이지가 언로드될 때를 감지
const destroyObserver = {
	observe(subject, topic, data) {
		const id = subject.QueryInterface(Ci.nsISupportsPRUint64).data;

		// 등록된 페이지가 아니면 건너뛰기
		if(!openPages[id]) return;

		/* console.log(`[Freemem] ${openPages[id]}(${id}) 닫힘`); */

		// 등록 해제
		delete openPages[id];

		// 메모리 정리
		freeMemory();
	},

	register() {
		Services.obs.addObserver(this, 'inner-window-destroyed', false);
	},

	unregister() {
		Services.obs.removeObserver(this, 'inner-window-destroyed');
	},
};

// 설정 변경 감지기
const prefObserver = {
	observe(subject, topic, data) {
		// 바뀐 게 아니라면 취소
		if(topic !== 'nsPref:changed') return;

		// 새 값 가져오기
		const value = Services.prefs.getBoolPref(branch + data);

		/* Services.prompt.alert(null, null, `설정 변경: ${data} -> ${value}`); */

		// 새 설정과 값에 따라 작업 실행
		switch(data) {
			case 'free_on_page_unload': {
				if(value) {
					createObserver.register();
					destroyObserver.register();
				} else {
					createObserver.unregister();
					destroyObserver.unregister();
				}
			} break; case 'free_on_close': {
				if(value) {
					processWindows(attachHandler);
					Services.wm.addListener(windowListener);
				} else {
					Services.wm.removeListener(windowListener);
					detachAllHandlers();
				}
			}
		}
	},

	register() {
		prefBranch.addObserver('', this, false);
	},

	unregister() {
		prefBranch.removeObserver('', this);
	},
};

// 설정 등록
function initPreferences() {
	// 설정 기본값 분기
	const defaultBranch = Services.prefs.getDefaultBranch(branch);

	// 기본값 등록
	defaultBranch.setBoolPref('gc', true);
	defaultBranch.setBoolPref('minimize_memory_usage', false);  // 끊김이 좀 심해서 false
	if(runtime.OS === 'WINNT')
		defaultBranch.setBoolPref('empty_working_set', false);  // 작업 관리자에서 보이는 사용량만 줄고 실제 효과는 거의 없어서 기본 false
	defaultBranch.setBoolPref('free_on_close', false);  // free_on_page_unload와 역할이 살짝 중복되는 면이 있음
	defaultBranch.setBoolPref('free_on_page_unload', true);
	defaultBranch.setIntPref('free_delay', 1000);
}

// Windows API 함수 불러오기
function loadWinapi() {
	// 윈도우 전용
	if(runtime.OS !== 'WINNT') return;

	try {
		// Windows API 라이브러리 불러오기
		kernel32 = ctypes.open('kernel32.dll');
		psapi = ctypes.open('psapi.dll');

		// Windows API 함수 불러오기
		GetCurrentProcess = kernel32.declare('GetCurrentProcess', ctypes.winapi_abi, ctypes.voidptr_t);
		EmptyWorkingSet = psapi.declare('EmptyWorkingSet', ctypes.winapi_abi, ctypes.bool, ctypes.voidptr_t);
	} catch(e) {}
}

// Windows API 라이브러리 닫기
function unloadWinapi() {
	kernel32?.close();
	psapi?.close();

	kernel32 = null;
	psapi = null;

	GetCurrentProcess = null;
	EmptyWorkingSet = null;
}

// 확장 프로그램이 활성화될 때
function startup(data, reason) {
	// 기본 설정 등록
	initPreferences();

	// Windows API 함수 불러오기
	loadWinapi();

	if(Services.prefs.getBoolPref(branch + 'free_on_close')) {
		// 기존 창에 탭 닫기 이벤트 수신기 붙이기
		processWindows(attachHandler);

		// 창 열기 이벤트 감지기 등록
		Services.wm.addListener(windowListener);
	}

	// 웹 페이지 언로드 이벤트 감지기 등록
	if(Services.prefs.getBoolPref(branch + 'free_on_page_unload')) {
		createObserver.register();
		destroyObserver.register();
	}

	// 설정 변경 감지기 등록
	prefObserver.register();
}

// 확장 프로그램이 비활성화될 때
function shutdown(data, reason) {
	// 메모리 정리 작업 취소
	freeTask?.cancel();

	// 웹 페이지 언로드 이벤트 감지기 해제
	if(Services.prefs.getBoolPref(branch + 'free_on_page_unload')) {
		createObserver.unregister();
		destroyObserver.unregister();
	}

	if(Services.prefs.getBoolPref(branch + 'free_on_close')) {
		// 창 열기 이벤트 감지기 해제
		Services.wm.removeListener(windowListener);

		// 이미 붙어 있던 탭 닫기 감지기 해제
		detachAllHandlers();
	}

	// Windows API 라이브러리 닫기
	unloadWinapi();

	// 설정 변경 감지기 해제
	prefObserver.unregister();
}

// 확장 프로그램이 설치될 때
function install() {}

// 확장 프로그램이 제거될 때
function uninstall() {}
