# FleetLink iOS Share Sheet Shortcut & Mobile Export

This guide explains how to export and share files directly from an iPhone or iPad to FleetLink using Apple Shortcuts (integrated into the native iOS Share Sheet) or the Safari Web Upload Wizard.

---

## Method 1: Apple Shortcut (Share Sheet Integration)

With this Shortcut installed, tapping **Share** in any iOS app (Files, Photos, Safari, Notes, etc.) and selecting **"Share to FleetLink"** uploads the item directly to FleetLink and copies the share URL to your clipboard.

### Option A: 1-Tap Download & Install (Recommended)

1. Navigate to **`https://fleetlink.online`** on your iPhone, iPad, or Mac.
2. In the **📲 Apple Shortcut** card at the top:
   - Tap **"Copy Secret for Shortcut"** (copies your active Admin or Agent secret to the clipboard).
   - Tap **"Download Official Shortcut (.shortcut)"** to download the Apple-signed shortcut (`/Share-to-FleetLink.shortcut`).
   - Alternatively, tap **"Download Pre-Filled Shortcut"** (`/api/shortcut/download`) to get a shortcut with your secret already baked in.
3. Safari will open the file in the **Shortcuts** app:
   - Tap **"Add Shortcut"**.
   - If prompted for your secret token, simply tap **Paste**.
4. You're done!  Open **Photos**, **Files**, or **Safari**, tap **Share**, and select **"Share to FleetLink"**.

---

### Option B: Manual Setup (Build from Scratch)

```
1. Receive [Any] from [Share Sheet]
   If no input: [Ask for] [Files]

2. Text -> Slug
   [Ask for text] with prompt "Custom slug (leave blank for auto)?"
   If [Provided Input] is empty:
     Generate Random UUID or Format Date [Current Date] "yyyyMMdd-HHmmss"

3. Choose from Menu: "Select Retention (TTL)"
   - 1 Day
   - 3 Days (Default)
   - 7 Days
   - Permanent (Forever)

4. Text -> Password (Optional)
   [Ask for text] with prompt "Password protect? (leave blank for public)"

5. Get Details of File:
   - File Name -> [File Name]
   - File Extension -> [File Extension]

6. Get Contents of URL:
   - URL: https://fleetlink.online/[Slug]/[File Name]
   - Method: PUT
   - Headers:
       X-Fleet-Admin: <YOUR_FLEET_ADMIN_SECRET>
       X-Expire-Days: [Selected TTL]
       X-Fleet-Password: [Password] (omit header if empty)
   - Request Body: File -> [Shortcut Input]

7. Copy to Clipboard:
   https://fleetlink.online/[Slug]/[File Name]

8. Show Notification:
   "FleetLink share link copied to clipboard!"
```

---

## Method 2: Mobile Safari Web Upload Wizard

If you prefer a visual web form without setting up a Shortcut:

1. Open Safari on iPhone and navigate to `https://fleetlink.online`.
2. The **🚀 Direct Web Upload Wizard** is located prominently right below the header:
   - **Inline Secret Token:** Enter your `FLEET_ADMIN_SECRET` or `FLEET_AGENT_SECRET` directly in the yellow token box (or tap "Authenticate" in the top bar to remember your session).
   - Tap **"Tap or drag files / photos here to upload"** to pick documents from the iOS **Files** app or photo library.
   - Choose your custom **Slug** or let it auto-generate.
   - Select your expiration timeframe (**1 Day**, **3 Days**, **7 Days**, or **Forever**).
   - Set an optional password if you want the link protected.
   - Tap **"Upload to FleetLink"**.
3. Once uploaded, the direct link is displayed with a 1-tap **Copy Link** button, and your browser session cookie is stored automatically for future uploads.

> **Tip:** In Safari, tap the Share button and select **"Add to Home Screen"** to save FleetLink as a convenient home screen shortcut icon on your iPhone for quick mobile access to the web upload wizard.
