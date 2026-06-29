# GitHub Actions 打包 iOS

这个仓库已经接入了 GitHub Actions 的 `macOS runner`，工作流文件在：

- [ios-build.yml](file:///workspace/.github/workflows/ios-build.yml)

## 你能得到什么

- `不带签名的模拟器包`
  - 任何时候都能跑。
  - 产物是 `App.app`，用于验证 iOS 工程能否正常编译。

- `带签名的 IPA`
  - 需要你在 GitHub 仓库里提前配置苹果签名 secrets。
  - 产物是可分发的 `.ipa`。

## 怎么触发

1. 把代码推到 GitHub 仓库。
2. 打开仓库的 `Actions` 页。
3. 选择 `iOS Build` 工作流。
4. 点击 `Run workflow`。
5. 如果只想验证工程是否能编译：
   - `signed_build = false`
6. 如果要导出 `.ipa`：
   - `signed_build = true`
   - `export_method` 选择：
     - `app-store`
     - `ad-hoc`
     - `development`

## 必要 Secrets

如果你要导出签名 `ipa`，在 GitHub 仓库 `Settings -> Secrets and variables -> Actions` 里新增这些 `Repository secrets`：

- `APPLE_TEAM_ID`
  - 苹果开发者团队 ID

- `IOS_CERTIFICATE_P12_BASE64`
  - 你的签名证书 `.p12` 文件做 Base64 后的内容

- `IOS_CERTIFICATE_PASSWORD`
  - 这个 `.p12` 的导出密码

- `IOS_PROVISIONING_PROFILE_BASE64`
  - 描述文件 `.mobileprovision` 做 Base64 后的内容

- `KEYCHAIN_PASSWORD`
  - 工作流里临时 keychain 的任意密码，自己设一个强密码即可

## 如何生成 Base64

### Linux

```bash
base64 -w 0 ios_distribution.p12
base64 -w 0 App.mobileprovision
```

### macOS

```bash
base64 -i ios_distribution.p12
base64 -i App.mobileprovision
```

### Windows PowerShell

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("ios_distribution.p12"))
[Convert]::ToBase64String([IO.File]::ReadAllBytes("App.mobileprovision"))
```

## 产物在哪

- `signed_build = false`
  - 在 workflow artifacts 里下载 `ios-simulator-app`

- `signed_build = true`
  - 在 workflow artifacts 里下载 `ios-signed-ipa`

## 当前项目的注意点

- 当前 iOS Bundle ID 是 `fun.zihang.caelumshao`
- 当前 App 名称是 `云韶 CaelumShao`
- 前端会把 `/api` 和 `/media` 请求转发到远端 HTTPS 服务，不会在 iPhone 里运行本地 Node 服务

如果以后你要换 Bundle ID，需要同时确保：

1. Xcode 工程里的 `PRODUCT_BUNDLE_IDENTIFIER` 改成新的值
2. 你的 Provisioning Profile 也对应这个新的 Bundle ID

## 常见失败原因

- `Missing required secret`
  - GitHub 仓库里少配了 signing secrets

- `No profiles for ... were found`
  - 描述文件的 Bundle ID 和工程里的 Bundle ID 不匹配

- `No signing certificate`
  - `.p12` 证书不对，或密码错误

- `exportArchive` 失败
  - `export_method` 和证书/描述文件类型不一致
  - 例如你选了 `app-store`，但上传的是开发证书或开发描述文件
