# LibreOffice for the Windows installer

The installer ships LibreOffice inside the app (decided). Before `npm run installer`, copy a Windows
LibreOffice installation here so that `vendor/libreoffice/program/soffice.exe` exists (for example, install
LibreOffice on the build PC and copy the contents of `C:\Program Files\LibreOffice`). The app looks for it at
`resources/libreoffice/program/soffice.exe` first, then for an installed copy.

Nothing in this folder but this file is kept in git. LibreOffice is under the Mozilla Public License 2.0: its own
license files travel with the copy, and the installer's first page says so (build/license.txt).
