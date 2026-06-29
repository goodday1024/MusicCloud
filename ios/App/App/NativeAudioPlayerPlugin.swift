import Foundation
import AVFoundation
import Capacitor

@objc(NativeAudioPlayerPlugin)
public class NativeAudioPlayerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeAudioPlayerPlugin"
    public let jsName = "NativeAudioPlayer"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seekTo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setVolume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise)
    ]

    private var player: AVPlayer?
    private var playerItemStatusObserver: NSKeyValueObservation?
    private var timeControlObserver: NSKeyValueObservation?
    private var timeObserverToken: Any?
    private var endObserver: NSObjectProtocol?
    private var currentUrl = ""

    deinit {
        teardownPlayer()
    }

    public override func load() {
        super.load()
        configureAudioSession()
    }

    @objc func play(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), let url = URL(string: urlString) else {
            call.reject("缺少可播放 url")
            return
        }
        configureAudioSession()
        teardownPlayer()

        currentUrl = urlString
        let item = AVPlayerItem(url: url)
        let player = AVPlayer(playerItem: item)
        player.automaticallyWaitsToMinimizeStalling = true
        player.volume = Float(call.getDouble("volume") ?? 1)
        self.player = player
        observe(player: player, item: item)
        player.play()
        notifyListeners("stateChange", data: statusPayload(playingOverride: true, forceSync: true))
        call.resolve(statusPayload(playingOverride: true, forceSync: true))
    }

    @objc func pause(_ call: CAPPluginCall) {
        guard let player else {
            call.resolve(statusPayload())
            return
        }
        player.pause()
        let payload = statusPayload(playingOverride: false, forceSync: true)
        notifyListeners("stateChange", data: payload)
        call.resolve(payload)
    }

    @objc func resume(_ call: CAPPluginCall) {
        guard let player else {
            call.reject("播放器尚未初始化")
            return
        }
        configureAudioSession()
        player.play()
        let payload = statusPayload(playingOverride: true, forceSync: true)
        notifyListeners("stateChange", data: payload)
        call.resolve(payload)
    }

    @objc func stop(_ call: CAPPluginCall) {
        teardownPlayer()
        let payload = statusPayload(playingOverride: false, stopped: true, forceSync: true)
        notifyListeners("stateChange", data: payload)
        call.resolve(payload)
    }

    @objc func seekTo(_ call: CAPPluginCall) {
        guard let player else {
            call.reject("播放器尚未初始化")
            return
        }
        let timeValue = max(0, call.getDouble("time") ?? 0)
        let target = CMTime(seconds: timeValue, preferredTimescale: 600)
        player.seek(to: target, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
            guard let self else { return }
            let payload = self.statusPayload(forceSync: true)
            self.notifyListeners("stateChange", data: payload)
            call.resolve(payload)
        }
    }

    @objc func setVolume(_ call: CAPPluginCall) {
        let volume = Float(min(1, max(0, call.getDouble("volume") ?? 1)))
        player?.volume = volume
        call.resolve(statusPayload())
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        call.resolve(statusPayload())
    }

    private func configureAudioSession() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: [.allowAirPlay, .allowBluetoothA2DP])
            try session.setActive(true)
        } catch {
            CAPLog.print("NativeAudioPlayer audio session failed: \(error.localizedDescription)")
        }
    }

    private func observe(player: AVPlayer, item: AVPlayerItem) {
        playerItemStatusObserver = item.observe(\.status, options: [.new, .initial]) { [weak self] item, _ in
            guard let self else { return }
            switch item.status {
            case .readyToPlay:
                self.notifyListeners("stateChange", data: self.statusPayload(forceSync: true))
            case .failed:
                self.notifyListeners("stateChange", data: self.statusPayload(
                    playingOverride: false,
                    error: item.error?.localizedDescription ?? "原生 FLAC 解码失败",
                    forceSync: true
                ))
            default:
                break
            }
        }

        timeControlObserver = player.observe(\.timeControlStatus, options: [.new, .initial]) { [weak self] player, _ in
            guard let self else { return }
            let isPlaying = player.timeControlStatus == .playing
            self.notifyListeners("stateChange", data: self.statusPayload(playingOverride: isPlaying, forceSync: true))
        }

        timeObserverToken = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.5, preferredTimescale: 600),
            queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            self.notifyListeners("stateChange", data: self.statusPayload())
        }

        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: item,
            queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            self.notifyListeners("stateChange", data: self.statusPayload(playingOverride: false, ended: true, forceSync: true))
        }
    }

    private func teardownPlayer() {
        if let timeObserverToken, let player {
            player.removeTimeObserver(timeObserverToken)
        }
        if let endObserver {
            NotificationCenter.default.removeObserver(endObserver)
        }
        playerItemStatusObserver = nil
        timeControlObserver = nil
        timeObserverToken = nil
        endObserver = nil
        player?.pause()
        player = nil
        currentUrl = ""
    }

    private func statusPayload(
        playingOverride: Bool? = nil,
        ended: Bool = false,
        stopped: Bool = false,
        error: String? = nil,
        forceSync: Bool = false
    ) -> [String: Any] {
        let currentTime = player?.currentTime().seconds ?? 0
        let duration = player?.currentItem?.duration.seconds ?? 0
        let payload: [String: Any] = [
            "url": currentUrl,
            "currentTime": currentTime.isFinite ? currentTime : 0,
            "duration": duration.isFinite ? duration : 0,
            "playing": playingOverride ?? (player?.timeControlStatus == .playing),
            "ended": ended,
            "stopped": stopped,
            "forceSync": forceSync,
            "error": error ?? ""
        ]
        return payload
    }
}
