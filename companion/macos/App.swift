// Forever AI Companion for macOS: the native part of the app bundle.
//
// Without arguments it is the app the player opens: an icon in the menu bar,
// the app window (the same local page the Windows version shows in Edge) and
// the dialogs. It starts the service (Contents/MacOS/ForeverAICompanionService,
// the Node program shared with Windows) and talks to it line by line:
//   service -> app (its stdout, lines starting with "@@faic "):
//     url <url>                       address of the app window
//     window                          show the window
//     texts <base64 key=value lines>  texts in the app's language
//     ask                             "keep running or close?" (window closed)
//     balloon <text>                  small notice
//     notify <title><TAB><text>       notice with its own title
//     pick-folder <id> <b64 title>    folder dialog  -> "picked <id> <b64 path or ->"
//     pick-file <id> <b64 title>      file dialog    -> "picked <id> <b64 path or ->"
//     alert <b64 text>                error dialog (shown before quitting)
//   app -> service (its stdin):
//     open | quit | closed | choice tray|quit 0|1 | picked <id> <b64>
// When the service exits, the app quits with it.
//
// With arguments it runs one task for the service and exits:
//   --capture <height> [--whole-screen] [--no-prompt]  reads the addon's strip from the WoW window
//   --voices                       the voices the game can use (JSON)
//   --refresh-voices               tells macOS the silent voice changed
//   --screen-access check|request  Screen Recording permission
//   --login-item status|on|off     open at login
//   --say <text>                   speaks with the silent voice (diagnostics)
import AppKit
import AVFoundation
import CoreMedia
import ScreenCaptureKit
import ServiceManagement
import UserNotifications
import WebKit

let APP_NAME = "Forever AI Companion"

// The standard menus in the player's language (the service sends the rest).
let spanish = Locale.preferredLanguages.first?.lowercased().hasPrefix("es") ?? false
func L(_ en: String, _ es: String) -> String { spanish ? es : en }

func out(_ s: String) {
    FileHandle.standardOutput.write(Data((s + "\n").utf8))
}

func b64(_ s: String) -> String { Data(s.utf8).base64EncodedString() }
func unb64(_ s: String) -> String {
    guard let d = Data(base64Encoded: s) else { return "" }
    return String(decoding: d, as: UTF8.self)
}

// MARK: - Small tasks for the service

func listVoices() -> Never {
    let list = AVSpeechSynthesisVoice.speechVoices().map { ["name": $0.name, "id": $0.identifier, "lang": $0.language] }
    let data = (try? JSONSerialization.data(withJSONObject: list)) ?? Data("[]".utf8)
    FileHandle.standardOutput.write(data)
    out("")
    exit(0)
}

func screenAccess(_ mode: String) -> Never {
    var granted = CGPreflightScreenCaptureAccess()
    if !granted && mode == "request" { granted = CGRequestScreenCaptureAccess() }
    out(granted ? "granted" : "denied")
    exit(0)
}

func loginItem(_ mode: String) -> Never {
    let svc = SMAppService.mainApp
    do {
        if mode == "on" { try svc.register() }
        if mode == "off" { try svc.unregister() }
    } catch {
        FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
    }
    switch svc.status {
    case .enabled: out("on")
    case .requiresApproval: out("approval")
    default: out("off")
    }
    exit(0)
}

final class SayDelegate: NSObject, AVSpeechSynthesizerDelegate {
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didFinish u: AVSpeechUtterance) { out("finished"); exit(0) }
    func speechSynthesizer(_ s: AVSpeechSynthesizer, didCancel u: AVSpeechUtterance) { out("cancelled"); exit(1) }
}

func say(_ text: String) -> Never {
    guard let voice = AVSpeechSynthesisVoice.speechVoices().first(where: { $0.name.hasPrefix("ForeverAICompanion") }) else {
        out("no-voice")
        exit(2)
    }
    let synth = AVSpeechSynthesizer()
    let delegate = SayDelegate()
    synth.delegate = delegate
    let u = AVSpeechUtterance(string: text)
    u.voice = voice
    u.volume = 0
    synth.speak(u)
    RunLoop.main.run(until: Date().addingTimeInterval(20))
    out("timeout")
    exit(1)
}

// MARK: - Reading the strip from the WoW window

// Prints "FRAME <seq> <attempt> <width> <height> <base64 RGB>" for each sighting
// of the addon's strip (up to 3 grabs per appearance), like the Windows reader
// (src/screen-reader.js). The window is captured with ScreenCaptureKit, so it
// is read even when other windows cover it.
final class StripReader: NSObject, SCStreamOutput, SCStreamDelegate {
    let captureHeight: Int
    let wholeScreen: Bool
    // A windowed game has the title bar above its content: the strip is looked
    // for in the first rows.
    let searchRows = 90
    var stream: SCStream?
    var target: (id: UInt32, w: CGFloat, h: CGFloat)?
    var seq = 0
    var tries = 0
    var visible = false
    let queue = DispatchQueue(label: "faic.capture")
    let outQueue = DispatchQueue(label: "faic.out")

    init(captureHeight: Int, wholeScreen: Bool) {
        self.captureHeight = captureHeight
        self.wholeScreen = wholeScreen
    }

    func start() {
        out("READY")
        find()
        Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in self?.find() }
    }

    func scale(for frame: CGRect) -> CGFloat {
        // SCWindow frames use the top-left origin of the main display.
        let mainH = NSScreen.screens.first?.frame.height ?? 0
        let flipped = CGRect(x: frame.minX, y: mainH - frame.maxY, width: frame.width, height: frame.height)
        let screens = NSScreen.screens.filter { $0.frame.intersects(flipped) }
        return screens.map { $0.backingScaleFactor }.max() ?? NSScreen.main?.backingScaleFactor ?? 2
    }

    func find() {
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { [weak self] content, error in
            guard let self else { return }
            guard let content else {
                // No Screen Recording permission: the service tries again later, quietly.
                if let e = error as NSError?, e.code == -3801 {
                    out("NOPERM")
                    exit(3)
                }
                FileHandle.standardError.write(Data("capture: \(error?.localizedDescription ?? "no content")\n".utf8))
                return
            }
            let filter: SCContentFilter
            let frame: CGRect
            let id: UInt32
            if self.wholeScreen {
                guard let d = content.displays.first else { return }
                filter = SCContentFilter(display: d, excludingWindows: [])
                frame = d.frame
                id = d.displayID
            } else {
                let wow = content.windows.filter {
                    let bundle = $0.owningApplication?.bundleIdentifier ?? ""
                    let name = $0.owningApplication?.applicationName ?? ""
                    return (bundle == "com.blizzard.worldofwarcraft" || name.hasPrefix("World of Warcraft"))
                        && $0.windowLayer == 0 && $0.frame.width >= 200 && $0.frame.height >= 100
                }.max { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }
                guard let w = wow else {
                    self.stop()
                    return
                }
                filter = SCContentFilter(desktopIndependentWindow: w)
                frame = w.frame
                id = w.windowID
            }
            if let t = self.target, t.id == id, t.w == frame.width, t.h == frame.height, self.stream != nil { return }
            self.stop()
            let s = self.scale(for: frame)
            let bandPoints = min(frame.height, CGFloat(self.captureHeight + self.searchRows) / s)
            let cfg = SCStreamConfiguration()
            cfg.sourceRect = CGRect(x: 0, y: 0, width: frame.width, height: bandPoints)
            cfg.width = Int((frame.width * s).rounded())
            cfg.height = Int((bandPoints * s).rounded())
            cfg.pixelFormat = kCVPixelFormatType_32BGRA
            cfg.showsCursor = false
            cfg.queueDepth = 4
            cfg.minimumFrameInterval = CMTime(value: 1, timescale: 40)
            let stream = SCStream(filter: filter, configuration: cfg, delegate: self)
            do {
                try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: self.queue)
            } catch {
                FileHandle.standardError.write(Data("capture: \(error.localizedDescription)\n".utf8))
                return
            }
            self.stream = stream
            self.target = (id, frame.width, frame.height)
            stream.startCapture { err in
                if let err {
                    FileHandle.standardError.write(Data("capture: \(err.localizedDescription)\n".utf8))
                    self.stream = nil
                    self.target = nil
                }
            }
        }
    }

    func stop() {
        stream?.stopCapture { _ in }
        stream = nil
        target = nil
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        FileHandle.standardError.write(Data("capture stopped: \(error.localizedDescription)\n".utf8))
        DispatchQueue.main.async { self.stream = nil; self.target = nil }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sb.isValid, let pb = CMSampleBufferGetImageBuffer(sb) else { return }
        // Only complete frames carry pixels.
        if let atts = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
           let raw = atts.first?[.status] as? Int, let status = SCFrameStatus(rawValue: raw), status != .complete { return }
        CVPixelBufferLockBaseAddress(pb, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(pb) else { return }
        let w = CVPixelBufferGetWidth(pb)
        let h = CVPixelBufferGetHeight(pb)
        let stride = CVPixelBufferGetBytesPerRow(pb)
        let px = base.assumingMemoryBound(to: UInt8.self)
        if w < 40 || h < 9 { return }
        var top = -1
        for y0 in 0...max(0, min(searchRows, h - 9)) where marker(px, stride, y0) {
            top = y0
            break
        }
        if top < 0 {
            visible = false
            return
        }
        if !visible { visible = true; seq += 1; tries = 0 }
        if tries >= 3 { return }
        tries += 1
        let rows = min(captureHeight, h - top)
        var rgb = Data(count: w * rows * 3)
        rgb.withUnsafeMutableBytes { (dst: UnsafeMutableRawBufferPointer) in
            let d = dst.bindMemory(to: UInt8.self)
            for r in 0..<rows {
                let src = px + (top + r) * stride
                for c in 0..<w {
                    let s = c * 4, o = (r * w + c) * 3
                    d[o] = src[s + 2]; d[o + 1] = src[s + 1]; d[o + 2] = src[s]
                }
            }
        }
        let line = "FRAME \(seq) \(tries) \(w) \(rows) \(rgb.base64EncodedString())"
        outQueue.async { out(line) }
    }

    // BGRA pixel helpers.
    @inline(__always) func lum(_ p: UnsafePointer<UInt8>, _ stride: Int, _ x: Int, _ y: Int) -> Int {
        let i = y * stride + x * 4
        return (Int(p[i]) + Int(p[i + 1]) + Int(p[i + 2])) / 3
    }
    @inline(__always) func gray(_ p: UnsafePointer<UInt8>, _ stride: Int, _ x: Int, _ y: Int) -> Bool {
        let i = y * stride + x * 4
        return abs(Int(p[i]) - Int(p[i + 1])) < 12 && abs(Int(p[i + 1]) - Int(p[i + 2])) < 12
    }

    // Ruler (gray/black alternating 3 px cells on row 0) + 4 increasing grays on
    // row 1, with the strip's top edge at row y0. Same test as on Windows.
    func marker(_ p: UnsafePointer<UInt8>, _ stride: Int, _ y0: Int) -> Bool {
        let white = lum(p, stride, 1, y0 + 1)
        if white < 60 || !gray(p, stride, 1, y0 + 1) { return false }
        for i in 0..<8 {
            let x = i * 3 + 1
            let v = lum(p, stride, x, y0 + 1)
            if i % 2 == 0 {
                if abs(v - white) > white / 4 || !gray(p, stride, x, y0 + 1) { return false }
            } else if v > white / 4 { return false }
        }
        var prev = -1
        for k in 1...4 {
            let x = k * 3 + 1
            if !gray(p, stride, x, y0 + 4) { return false }
            let v = lum(p, stride, x, y0 + 4)
            if k > 1 && v < prev + white / 6 { return false }
            prev = v
        }
        return true
    }
}

func capture(_ args: [String]) -> Never {
    let height = Int(args.first ?? "") ?? 160
    if args.contains("--no-prompt") && !CGPreflightScreenCaptureAccess() {
        out("NOPERM")
        exit(3)
    }
    _ = NSApplication.shared
    let reader = StripReader(captureHeight: height, wholeScreen: args.contains("--whole-screen"))
    reader.start()
    // The service closes our stdin when it stops: stop with it.
    DispatchQueue.global().async {
        while true {
            let d = FileHandle.standardInput.availableData
            if d.isEmpty { exit(0) }
        }
    }
    RunLoop.main.run()
    exit(0)
}

// MARK: - The app

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, UNUserNotificationCenterDelegate {
    var service: Process?
    var toService: FileHandle?
    var buffer = Data()
    var url: URL?
    var window: NSWindow?
    var webView: WKWebView?
    var statusItem: NSStatusItem?
    var quitting = false
    var serviceError: String?
    var background = false

    // English defaults; the service sends the texts in its language.
    var T: [String: String] = [
        "running": "\(APP_NAME): running",
        "open": "Open \(APP_NAME)",
        "close": "Quit \(APP_NAME)",
        "stillRunning": "\(APP_NAME) is still running",
        "clickHint": "Click its icon in the menu bar to open it again.",
        "askTitle": "Keep it running?",
        "askText": "If it keeps running in the background, you can keep asking from the game. You will find it in the menu bar: click its icon to open it again.\n\nIf you close it, the game will not get answers until you open it again.",
        "remember": "Remember my choice",
        "keep": "Keep running in the background",
        "quit": "Close the app",
    ]

    func applicationWillFinishLaunching(_ n: Notification) {
        // Opened at login (System Settings > Login Items): no window.
        if let ev = NSAppleEventManager.shared().currentAppleEvent,
           ev.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem {
            background = true
        }
    }

    func applicationDidFinishLaunching(_ n: Notification) {
        NSApp.setActivationPolicy(.accessory)
        buildMenu()
        buildStatusItem()
        UNUserNotificationCenter.current().delegate = self
        startService()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return true
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let svc = service, svc.isRunning else { return .terminateNow }
        if !quitting {
            quitting = true
            send("quit")
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) { [weak self] in
                if self?.service?.isRunning == true { self?.service?.terminate() }
                NSApp.reply(toApplicationShouldTerminate: true)
            }
        }
        return .terminateLater
    }

    // MARK: Service

    func startService() {
        let exe = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/ForeverAICompanionService")
        let p = Process()
        p.executableURL = exe
        var args = CommandLine.arguments.dropFirst().filter { !$0.hasPrefix("-psn_") }
        if background && !args.contains("--background") { args.append("--background") }
        p.arguments = Array(args)
        var env = ProcessInfo.processInfo.environment
        env["FAIC_SHELL"] = "1"
        p.environment = env
        let stdin = Pipe(), stdout = Pipe()
        p.standardInput = stdin
        p.standardOutput = stdout
        p.standardError = FileHandle.standardError
        stdout.fileHandleForReading.readabilityHandler = { [weak self] h in
            let d = h.availableData
            DispatchQueue.main.async { self?.received(d) }
        }
        p.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async { self?.serviceEnded() }
        }
        do {
            try p.run()
        } catch {
            alert("\(APP_NAME) could not start:\n\n\(error.localizedDescription)")
            NSApp.terminate(nil)
            return
        }
        service = p
        toService = stdin.fileHandleForWriting
    }

    func serviceEnded() {
        if let e = serviceError { alert(e) }
        if quitting {
            NSApp.reply(toApplicationShouldTerminate: true)
        } else {
            quitting = true
            NSApp.terminate(nil)
        }
    }

    func send(_ line: String) {
        guard let h = toService else { return }
        do { try h.write(contentsOf: Data((line + "\n").utf8)) } catch { /* service gone */ }
    }

    func received(_ d: Data) {
        if d.isEmpty { return }
        buffer.append(d)
        while let nl = buffer.firstIndex(of: 10) {
            let lineData = buffer.subdata(in: buffer.startIndex..<nl)
            buffer.removeSubrange(buffer.startIndex...nl)
            let line = String(decoding: lineData, as: UTF8.self)
            if line.hasPrefix("@@faic ") { command(String(line.dropFirst(7))) }
        }
    }

    func command(_ line: String) {
        let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
        let cmd = parts.first ?? ""
        let rest = parts.count > 1 ? parts[1] : ""
        switch cmd {
        case "url": url = URL(string: rest)
        case "window": showWindow()
        case "texts": loadTexts(rest)
        case "ask": ask()
        case "balloon": notify(T["stillRunning"] ?? APP_NAME, rest)
        case "notify":
            let tt = rest.split(separator: "\t", maxSplits: 1).map(String.init)
            notify(tt.first ?? APP_NAME, tt.count > 1 ? tt[1] : "")
        case "pick-folder", "pick-file":
            let a = rest.split(separator: " ", maxSplits: 1).map(String.init)
            pick(id: a.first ?? "0", title: unb64(a.count > 1 ? a[1] : ""), folder: cmd == "pick-folder")
        case "alert": serviceError = unb64(rest)
        default: break
        }
    }

    func loadTexts(_ b: String) {
        for line in unb64(b).split(separator: "\n") {
            guard let eq = line.firstIndex(of: "=") else { continue }
            let k = String(line[line.startIndex..<eq])
            T[k] = String(line[line.index(after: eq)...]).replacingOccurrences(of: "\\n", with: "\n").replacingOccurrences(of: "\\\\", with: "\\")
        }
        statusItem?.button?.toolTip = T["running"]
        buildStatusMenu()
    }

    // MARK: Window

    func showWindow() {
        guard let url else { return }
        if window == nil {
            let cfg = WKWebViewConfiguration()
            // The page tells the service itself when it closes; here the window does.
            cfg.userContentController.addUserScript(WKUserScript(source: "window.__faicNative = true;", injectionTime: .atDocumentStart, forMainFrameOnly: true))
            let web = WKWebView(frame: .zero, configuration: cfg)
            web.navigationDelegate = self
            web.uiDelegate = self
            let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 860),
                             styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            w.title = APP_NAME
            w.contentView = web
            w.minSize = NSSize(width: 640, height: 560)
            w.isReleasedWhenClosed = false
            w.delegate = self
            w.center()
            w.setFrameAutosaveName("ForeverAICompanionWindow")
            web.load(URLRequest(url: url))
            window = w
            webView = web
        }
        NSApp.setActivationPolicy(.regular)
        // Opened from the menu bar or by a relaunch, the app may not be the
        // active one yet: the window still comes to the front.
        window?.orderFrontRegardless()
        window?.makeKeyAndOrderFront(nil)
        if #available(macOS 14.0, *) { NSApp.activate() } else { NSApp.activate(ignoringOtherApps: true) }
    }

    func windowWillClose(_ n: Notification) {
        guard (n.object as? NSWindow) === window else { return }
        webView?.loadHTMLString("", baseURL: nil) // stops the page's status polling
        window = nil
        webView = nil
        NSApp.setActivationPolicy(.accessory)
        if !quitting { send("closed") }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let u = action.request.url else { return decisionHandler(.cancel) }
        if u.scheme == "about" || u.host == "127.0.0.1" || u.host == "localhost" { return decisionHandler(.allow) }
        NSWorkspace.shared.open(u) // links to websites open in the browser
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let u = action.request.url { NSWorkspace.shared.open(u) }
        return nil
    }

    func webViewDidClose(_ webView: WKWebView) { window?.close() }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        alert(message)
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.addButton(withTitle: L("OK", "Aceptar"))
        a.addButton(withTitle: L("Cancel", "Cancelar"))
        completionHandler(a.runModal() == .alertFirstButtonReturn)
    }

    // MARK: Menu bar

    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: L("Hide \(APP_NAME)", "Ocultar \(APP_NAME)"), action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: L("Quit \(APP_NAME)", "Salir de \(APP_NAME)"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)
        // Edit: copy and paste (API keys) in the window.
        let editItem = NSMenuItem()
        let edit = NSMenu(title: L("Edit", "Edición"))
        edit.addItem(withTitle: L("Undo", "Deshacer"), action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: L("Redo", "Rehacer"), action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: L("Cut", "Cortar"), action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: L("Copy", "Copiar"), action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: L("Paste", "Pegar"), action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: L("Select All", "Seleccionar todo"), action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)
        let winItem = NSMenuItem()
        let win = NSMenu(title: L("Window", "Ventana"))
        win.addItem(withTitle: L("Close", "Cerrar"), action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        win.addItem(withTitle: L("Minimize", "Minimizar"), action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: L("Reload", "Recargar"), action: #selector(reload), keyEquivalent: "r")
        winItem.submenu = win
        main.addItem(winItem)
        NSApp.mainMenu = main
    }

    @objc func reload() { webView?.reload() }

    func buildStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = menuBarGlyph()
        item.button?.toolTip = T["running"]
        statusItem = item
        buildStatusMenu()
    }

    func buildStatusMenu() {
        let menu = NSMenu()
        let open = NSMenuItem(title: T["open"] ?? "Open", action: #selector(openFromMenu), keyEquivalent: "")
        open.target = self
        menu.addItem(open)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: T["close"] ?? "Quit", action: #selector(quitFromMenu), keyEquivalent: "")
        quit.target = self
        menu.addItem(quit)
        statusItem?.menu = menu
    }

    @objc func openFromMenu() { showWindow() }
    @objc func quitFromMenu() { NSApp.terminate(nil) }

    // MARK: Dialogs and notices

    func alert(_ text: String) {
        NSApp.activate(ignoringOtherApps: true)
        let a = NSAlert()
        a.messageText = APP_NAME
        a.informativeText = text
        a.alertStyle = .warning
        a.runModal()
    }

    func ask() {
        NSApp.activate(ignoringOtherApps: true)
        let a = NSAlert()
        a.messageText = T["askTitle"] ?? ""
        a.informativeText = T["askText"] ?? ""
        a.addButton(withTitle: T["keep"] ?? "Keep")
        a.addButton(withTitle: T["quit"] ?? "Quit")
        a.showsSuppressionButton = true
        a.suppressionButton?.title = T["remember"] ?? "Remember"
        if let img = NSApp.applicationIconImage { a.icon = img }
        let r = a.runModal()
        let remember = a.suppressionButton?.state == .on ? "1" : "0"
        send("choice \(r == .alertFirstButtonReturn ? "tray" : "quit") \(remember)")
    }

    func notify(_ title: String, _ body: String) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { ok, _ in
            guard ok else { return }
            let c = UNMutableNotificationContent()
            c.title = title
            c.body = body
            center.add(UNNotificationRequest(identifier: UUID().uuidString, content: c, trigger: nil))
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler done: @escaping () -> Void) {
        DispatchQueue.main.async { self.showWindow() }
        done()
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent n: UNNotification, withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner])
    }

    func pick(id: String, title: String, folder: Bool) {
        NSApp.activate(ignoringOtherApps: true)
        let p = NSOpenPanel()
        p.message = title
        p.canChooseDirectories = folder
        p.canChooseFiles = !folder
        p.allowsMultipleSelection = false
        p.treatsFilePackagesAsDirectories = true
        p.showsHiddenFiles = !folder
        let ok = p.runModal() == .OK
        send("picked \(id) \(ok && p.url != nil ? b64(p.url!.path) : "-")")
    }
}

// MARK: - Menu bar icon

// A 4-point star (the sparkle of the app icon).
func starPath(_ c: NSPoint, _ r: CGFloat, _ ri: CGFloat) -> NSBezierPath {
    let p = NSBezierPath()
    for i in 0..<8 {
        let a = CGFloat.pi / 2 + CGFloat(i) * .pi / 4
        let rr = i % 2 == 0 ? r : ri
        let pt = NSPoint(x: c.x + cos(a) * rr, y: c.y + sin(a) * rr)
        if i == 0 { p.move(to: pt) } else { p.line(to: pt) }
    }
    p.close()
    return p
}

// The app icon (a gear with a star, and a small sparkle) as a one-color
// silhouette. A template image: macOS draws it black or white to match the
// menu bar, like the system's own icons. Drawn as vectors, sharp at any scale.
func menuBarGlyph() -> NSImage {
    let img = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { _ in
        NSColor.black.setFill()
        let c = NSPoint(x: 8, y: 8)
        let tip: CGFloat = 7.3, root: CGFloat = 5.8, teeth = 8
        let gear = NSBezierPath()
        for i in 0..<teeth {
            let a = CGFloat(i) * 2 * .pi / CGFloat(teeth) + .pi / 8
            let pts: [(CGFloat, CGFloat)] = [(root, a - 0.31), (tip, a - 0.19), (tip, a + 0.19), (root, a + 0.31)]
            for (j, (r, ang)) in pts.enumerated() {
                let pt = NSPoint(x: c.x + cos(ang) * r, y: c.y + sin(ang) * r)
                if i == 0 && j == 0 { gear.move(to: pt) } else { gear.line(to: pt) }
            }
        }
        gear.close()
        gear.appendOval(in: NSRect(x: c.x - 3.7, y: c.y - 3.7, width: 7.4, height: 7.4)) // the hole
        gear.windingRule = .evenOdd
        gear.fill()
        starPath(c, 2.9, 0.8).fill()
        starPath(NSPoint(x: 15.4, y: 15.4), 2.5, 0.6).fill()
        return true
    }
    img.isTemplate = true
    img.accessibilityDescription = APP_NAME
    return img
}

// MARK: - Entry point

let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case "--voices": listVoices()
case "--refresh-voices":
    AVSpeechSynthesisProviderVoice.updateSpeechVoices()
    out("ok")
    exit(0)
case "--screen-access": screenAccess(args.count > 1 ? args[1] : "check")
case "--login-item": loginItem(args.count > 1 ? args[1] : "status")
case "--say": say(args.dropFirst().joined(separator: " "))
case "--capture": capture(Array(args.dropFirst()))
default:
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.run()
}
