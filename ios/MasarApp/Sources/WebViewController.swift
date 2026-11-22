import UIKit
import WebKit

/// شاشة التطبيق: WKWebView يحمّل الواجهة المضمّنة داخل التطبيق (Resources/www)
/// ويتصل بخادم «المسار العالمي اللوجستي» الذي يُدخل عنوانه عند أول تشغيل.
final class WebViewController: UIViewController, WKURLSchemeHandler, WKNavigationDelegate {

    private var webView: WKWebView!
    private let scheme = "masarapp"
    private let settingsKey = "masar_server_url"
    private let askedKey = "masar_asked_server"

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 10/255, green: 37/255, blue: 64/255, alpha: 1)

        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(self, forURLScheme: scheme)
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.scrollView.bounces = false
        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])

        let gear = UIButton(type: .system)
        gear.setTitle("⚙", for: .normal)
        gear.titleLabel?.font = .systemFont(ofSize: 20)
        gear.backgroundColor = UIColor(red: 18/255, green: 60/255, blue: 99/255, alpha: 0.85)
        gear.tintColor = .white
        gear.layer.cornerRadius = 16
        gear.translatesAutoresizingMaskIntoConstraints = false
        gear.addTarget(self, action: #selector(askServer), for: .touchUpInside)
        view.addSubview(gear)
        NSLayoutConstraint.activate([
            gear.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 6),
            gear.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 8),
            gear.widthAnchor.constraint(equalToConstant: 32),
            gear.heightAnchor.constraint(equalToConstant: 32)
        ])

        if UserDefaults.standard.bool(forKey: askedKey) { loadApp() } else { askServer() }
    }

    private func loadApp() {
        let srv = UserDefaults.standard.string(forKey: settingsKey) ?? ""
        var urlString = "\(scheme)://local/index.html"
        if !srv.isEmpty, let encoded = srv.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) {
            urlString += "?srv=\(encoded)"
        }
        if let url = URL(string: urlString) { webView.load(URLRequest(url: url)) }
    }

    @objc private func askServer() {
        let alert = UIAlertController(
            title: "عنوان خادم النظام",
            message: "أدخل عنوان خادم «المسار العالمي اللوجستي» للاتصال بالمصادقة والمزادات والمحفظة.\nمثال: https://api.example.com\nبدون خادم تعمل الواجهة في وضعها المحلي فقط.",
            preferredStyle: .alert)
        alert.addTextField { tf in
            tf.placeholder = "https://api.example.com"
            tf.text = UserDefaults.standard.string(forKey: self.settingsKey)
            tf.keyboardType = .URL
            tf.autocapitalizationType = .none
            tf.autocorrectionType = .no
            tf.textDirection = .leftToRight
        }
        alert.addAction(UIAlertAction(title: "حفظ ومتابعة", style: .default) { _ in
            var v = alert.textFields?.first?.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !v.isEmpty && !v.hasPrefix("http://") && !v.hasPrefix("https://") { v = "http://" + v }
            UserDefaults.standard.set(v, forKey: self.settingsKey)
            UserDefaults.standard.set(true, forKey: self.askedKey)
            self.loadApp()
        })
        alert.addAction(UIAlertAction(title: "بدون خادم الآن", style: .cancel) { _ in
            UserDefaults.standard.set("", forKey: self.settingsKey)
            UserDefaults.standard.set(true, forKey: self.askedKey)
            self.loadApp()
        })
        present(alert, animated: true)
    }

    // MARK: - تقديم ملفات الواجهة من داخل الحزمة

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else { return }
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        let clean = path.hasPrefix("/") ? String(path.dropFirst()) : path
        let ns = clean as NSString
        let file = ns.lastPathComponent
        let ext = ns.pathExtension.isEmpty ? "html" : ns.pathExtension
        let baseName = ns.pathExtension.isEmpty ? file : (file as NSString).deletingPathExtension
        let dir = ns.deletingLastPathComponent

        guard let fileURL = Bundle.main.url(forResource: baseName,
                                            withExtension: ext,
                                            subdirectory: dir.isEmpty ? "www" : "www/" + dir) else {
            urlSchemeTask.didFailWithError(NSError(domain: "masar", code: 404))
            return
        }
        guard let data = try? Data(contentsOf: fileURL) else {
            urlSchemeTask.didFailWithError(NSError(domain: "masar", code: 500))
            return
        }
        let response = URLResponse(url: url, mimeType: Self.mimeType(ext), expectedContentLength: data.count, textEncodingName: "utf-8")
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

    // MARK: - التنقل
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = navigationAction.request.url, url.scheme == "http" || url.scheme == "https" {
            UIApplication.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    static func mimeType(_ ext: String) -> String {
        switch ext.lowercased() {
        case "html": return "text/html"
        case "js": return "application/javascript"
        case "css": return "text/css"
        case "json", "webmanifest": return "application/json"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "svg": return "image/svg+xml"
        default: return "application/octet-stream"
        }
    }
}
