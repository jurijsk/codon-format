# Reinstall software review table

This is the current installation plan for the new Windows installation. The status below reflects the post-reinstall audit on 2026-08-15.

## WinGet-managed software

These items have a direct WinGet package path and are grouped by the recommended installation tier.

| Category      | Software                  | WinGet ID                               | Detected now                              | Priority |
| ------------- | ------------------------- | --------------------------------------- | ----------------------------------------- | -------- |
| Browser       | Microsoft Edge            | `Microsoft.Edge`                        | Installed and used                        | Tier 1   |
| Browser       | Google Chrome             | `Google.Chrome`                         | Installed                                 | Tier 1   |
| Code          | VS Code                   | `Microsoft.VisualStudioCode`            | Installed                                 | Tier 1   |
| Code          | Git                       | `Git.Git`                               | Installed                                 | Tier 1   |
| Code          | GitHub CLI                | `GitHub.cli`                            | Installed                                 | Tier 1   |
| Code          | Azure CLI                 | `Microsoft.AzureCLI`                    | Installed                                 | Tier 1   |
| Runtime       | Python 3.14 and launcher  | `Python.Python.3.14`, `Python.Launcher` | Installed                                 | Tier 1   |
| Runtime       | Pandoc                    | `JohnMacFarlane.Pandoc`                 | Installed through Scoop                   | Tier 2   |
| Runtime       | Fast Node Manager (`fnm`) | `Schniz.fnm`                            | Installed, update available to 1.39.0     | Tier 1   |
| Utilities     | Windows Terminal          | `Microsoft.WindowsTerminal`             | Installed                                 | Tier 0   |
| Other         | DeepL                     | `DeepL.DeepL`                           | Installed                                 | Tier 2   |
| Code          | Notepad++                 | `Notepad++.Notepad++`                   | Installed                                 | Tier 2   |
| Code          | OpenCode                  | `SST.OpenCodeDesktop`                   | Not installed                             | Tier 1   |
| PDF           | PDF Shaper Ultimate       | `Burnaware.PDFShaper.Ultimate`          | Installed                                 | Tier 2   |
| Cloud         | OneDrive                  | `Microsoft.OneDrive`                    | Installed                                 | Tier 1   |
| Runtime       | Node.js LTS               | `OpenJS.NodeJS.LTS`                     | Installed                                 | Tier 1   |
| Productivity  | Microsoft 365 / Office    | `Microsoft.Office`                      | Installed                                 | Tier 2   |
| PDF           | Foxit PDF Reader          | `Foxit.FoxitReader`                     | Install only if preferred                 | Tier 2   |
| PDF           | Adobe Acrobat Reader      | `Adobe.Acrobat.Reader.64-bit`           | Install only if Foxit is insufficient     | Tier 2   |
| Communication | Slack                     | `SlackTechnologies.Slack`               | Install after base setup                  | Tier 1   |
| Communication | Microsoft Teams           | `Microsoft.Teams`                       | Install only if still used                | Tier 1   |
| Design        | Figma                     | `Figma.Figma`                           | Install after base setup                  | Tier 3   |
| Design        | Figma Agent               | `Figma.FigmaAgent`                      | Not installed; Figma Desktop is installed | Tier 3   |
| Voice         | Wispr Flow                | `XP88W11PJ2V0T8`                        | Install from Microsoft Store via WinGet   | Tier 1   |
| API tools     | Postman                   | `Postman.Postman`                       | Install if API workflow remains           | Tier 3   |
| Media         | VLC                       | `VideoLAN.VLC`                          | Install only if still used                | Tier 4   |
| Graphics      | Affinity by Canva         | `Canva.Affinity`                        | Install if still used                     | Tier 3   |



another table with the same structure is padded as the previous one even though it does not need that

| Category      | Software                  | WinGet ID                               | Detected now                              | Priority |
| ------------- | ------------------------- | --------------------------------------- | ----------------------------------------- | -------- |
| Browser       | Microsoft                 | `Microsoft.Edge`                        | Installed                                 | Tier 1   |
| Browser       | Google                    | `Google.Chrome`                         | Installed                                 | Tier 1   |


## Everything else

These are the items that require deliberate planning beyond the normal Windows setup and WinGet installation.

| Category     | Software or item                                               | Planned source                                                                                                                                    | Restore/install action                                                             | Priority |
| ------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------- |
| Windows      | WinGet / App                                                   | [Microsoft App                                                                                                                                    | Not guaranteed on                                                                  | Tier 0   |
| bootstrap    | Installer                                                      | Installer](https://apps.microsoft.com/detail/9nblggh4nns1) or [official GitHub releases](https://github.com/microsoft/winget-cli/releases/latest) | clean Windows 10 media; install/update App Installer before `winget-bootstrap.ps1` |          |
| Windows      | WinGet backup                                                  | [GitHub winget-cli                                                                                                                                | Use if Microsoft Store                                                             | Tier 0   |
| bootstrap    | route                                                          | releases](https://github.com/microsoft/winget-cli/releases/latest)                                                                                | is unavailable                                                                     |          |
| Graphics/CAD | Autodesk Fusion 360                                            | [Autodesk download page](https://www.autodesk.com/products/fusion-360/free-trial)                                                                 | Download and install before using Fusion 360                                       | Tier 3   |
| PDF tools    | Scoop package bundle: Ghostscript, MuPDF, Poppler, QPDF, Typst | [scoop-export.json](scoop-export.json)                                                                                                            | Install Scoop, then run `npm run restore-scoop -- --Execute`                       | Tier 2   |
| Package      | Scoop                                                          | [scoop.sh](https://scoop.sh/)                                                                                                                     | Install Scoop first if                                                             | Tier 2   |
| manager      |                                                                |                                                                                                                                                   | missing                                                                            |          |
| PDF          | PDFXplorer                                                     | [PDFXplorer](https://www.pdfxplorer.com/)                                                                                                         | Download and install from the vendor                                               | Tier 2   |
| PDF          | Xodo PDF Reader                                                | Microsoft Store package `MSIX\\5E8FC25E.XODODOCS`                                                                                                 | Reinstall from Microsoft Store                                                     | Tier 2   |
| AI agents    | Claude Code                                                    | Official installer and Claude login                                                                                                               | Install and sign in after basic connectivity and Git are working                   | Tier 1   |
| Backup       | Personal folders                                               | Backup drive and OneDrive                                                                                                                         | Restore after Windows is stable                                                    | Tier 2   |
| Backup       | Browser profiles and passwords                                 | Browser sync/export                                                                                                                               | Restore after sign-in                                                              | Tier 2   |
| Backup       | VS Code settings and snippets                                  | Backup/profile export                                                                                                                             | Restore after VS Code install; account sync handles extensions                     | Tier 1   |
| Backup       | Project repositories and SSH keys                              | Git snapshot/backup                                                                                                                               | Restore after Git setup and GitLab access                                          | Tier 1   |
| Backup       | License keys and activation information                        | Saved text/vault                                                                                                                                  | Re-activate selected software                                                      | Tier 2   |

## Quick prioritization

### Tier 0: Recovery and connectivity

Install first so the machine is usable and the remaining setup can proceed:

- WinGet / App Installer
- Windows Update and the verified Intel Wi-Fi installer
- Windows Terminal and 7-Zip

### Tier 1: Development and AI-agent foundation

Install next, immediately after Windows updates and drivers, to restore connectivity and the working environment:

- Edge, Chrome, and OneDrive
- Git, GitHub CLI, and Azure CLI
- VS Code
- Node.js LTS and `fnm`
- Python and Tesseract OCR
- Claude Code
- OpenCode
- Slack and Teams
- Wispr Flow
- VS Code settings and project repositories

### Tier 2: Core productivity and documents

Install after the development foundation:

- Microsoft 365 / Office
- PowerToys and Notepad++
- DeepL
- PDF readers and tools
- Scoop package bundle
- Obsidian and Pandoc

### Tier 3: Design and 3D

Install later, after connectivity, development, and documents are working:

- Figma and Figma Agent
- Autodesk Fusion 360
- Affinity by Canva
- FreeCAD
- Paint.NET
- PrusaSlicer
- Postman

### Tier 4: Optional media and secondary tools

Install only after the main workflow is stable:

- MPC-HC
- VLC
- Descript
- DroidCam

### Restore after setup

- Browser profile data
- VS Code settings and snippets
- personal folders
- project repositories
- SSH keys
- PowerToys config
- custom fonts / app configs
