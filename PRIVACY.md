# NMSA privacy policy

**Effective date:** August 15, 2026

NMSA — No Man's Sky Atlas is a local-first Windows application. It helps a
person inspect, complete, repair, back up, and recover compatible No Man's Sky
save data stored on that person's device.

## Information handling

NMSA does not create an account, collect analytics, use advertising, transmit
telemetry, or upload save files. The WPF application communicates in-process.
Portable compatibility mode uses a short-lived, session-token-protected
listener restricted to the device's loopback interface; it is not accessible
from the internet or local network. Save content, backups, verification
records, and the WebView2 profile remain on the local device. NMSA may read a
game save folder that the person selects or that it finds in standard local
game-save locations; it uses that access solely to provide the requested local
save operation.

NMSA stores recovery backups and audit information locally under the current
Windows user's local application-data folder. A person can remove those local
files by uninstalling NMSA and deleting its local application-data folders.

## Support

If a person chooses to open a GitHub issue, GitHub processes the information
they provide under GitHub's own terms and privacy policy. Support reports must
not include save files, account identifiers, private keys, access tokens, or
other personal information.

## Changes and contact

Material changes to this policy will be published in this repository. For
support or privacy questions, open an issue at
https://github.com/roysdepo/NMSA/issues.
