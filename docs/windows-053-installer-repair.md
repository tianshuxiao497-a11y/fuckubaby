# Windows 0.5.3 installer repair 1

The installer previously rejected an application directory after an older uninstall left only its own `Uninstall.exe` and empty `engine` directories. The application entry point and installation manifest were already absent, so the directory looked unrelated.

Recognize a byte-identical previously built uninstaller, or the current installer, as installation residue. Keep the existing no-linked-tree checks, profile locks, staged payload verification, complete old-directory backup and rollback. A file merely named `Uninstall.exe` is insufficient.

The customer download keeps the published 0.5.3 application payload unchanged. The new ZIP is named `AdaptiveSpotBot-Buyer-Windows-0.5.3-repair1.zip`; the fixed Windows download URL remains unchanged. Linux and Mac package mappings are preserved.

Native installer self-tests cover recovery of uninstaller-only residue, backup preservation, rejection of an unrelated fake uninstaller, normal install/repair, stage failure, activation rollback, profile locks, market locks, shortcuts and preservation of profile records. An additional isolated fixture reproduces the exact 0.5.1 uninstaller found in the affected installation.

Installing or repairing does not start trading, clear credentials or discard transaction records.
