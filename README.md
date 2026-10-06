# GzMail

Email with the people you choose, laid out like a text conversation. It's a web app you install on your Android home screen. It talks to Gmail directly from your phone, with no server and no AI involved.

- **Add a contact** (＋): enter their name and one or more email addresses. The app pulls your complete history with them from Gmail and saves it on your phone.
- **Opening the app** checks Gmail for messages added since the last check, keeps only the ones involving your contacts, and adds them. It checks again every 2 minutes while the app is open.
- **Tap a bubble** to see From, To, Cc, the date, attachments and the full original email. You can also "Reply to this" or "Reply all" from there.
- **Type at the bottom** to reply. By default this replies to the most recent email in the conversation. Tap ✎ to start a new subject.
- **Tap the contact's name** at the top of a conversation to rename them, add addresses (for example a work address) or remove them.

To try it with fake data, add `?demo` to the address. Demo mode never touches Gmail.

## Security

- The code is public on GitHub, but it contains **no secrets**. The Client ID in `config.js` isn't a password. Google only accepts it from the website address you list in step 1.
- **Your email never goes to GitHub or to any server.** Your phone downloads it directly from Google and stores it only in the app's private storage on that phone.
- Only accounts you add as **test users** (just you) can sign in. Anyone else gets "access denied" from Google.
- The app shows email as plain text and never runs HTML or scripts from an email. Remote images don't load, so senders can't tell when you've opened a message. A strict security policy also limits the page to connecting only to Google.
- To revoke access at any time, go to myaccount.google.com → Security → Third-party connections → GzMail.

## One-time setup (about 15 minutes)

### 1. Google Cloud: let the app use your Gmail
1. Go to https://console.cloud.google.com, sign in as gbensinger@gmail.com, and create a project named **GzMail**.
2. Go to **APIs & Services → Library**, search for **Gmail API**, and click **Enable**.
3. Go to **APIs & Services → OAuth consent screen** (labeled "Google Auth Platform" in newer consoles):
   - User type: **External**. App name: something that doesn't resemble a Google product (Google rejected "GzMail" with a vague error; "Greg Inbox Tool" worked). Use your email for the support and developer contacts.
   - Under **Audience → Test users**, add **gbensinger@gmail.com**.
   - Leave the publishing status as **Testing**.
4. Go to **Credentials** (or **Clients**) → **Create OAuth client ID**:
   - Type: **Web application**
   - Under **Authorized JavaScript origins**, add `https://<your-github-username>.github.io`
   - Add no redirect URIs. Click Create and copy the **Client ID**. You don't need the client secret, so never put it in this repo.
   - New settings can take from a few minutes to a few hours to apply. An `origin_mismatch` error on your first sign-in usually means to wait.
5. Paste the Client ID into `config.js`.

### 2. GitHub Pages: put the app online
1. Create a new repository on GitHub named `gzmail` and upload these files to it.
2. Go to the repository's **Settings → Pages**, set Source to *Deploy from a branch*, choose branch `main` and folder `/ (root)`, and save.
3. After about a minute, the app is live at `https://<your-github-username>.github.io/gzmail/`.

### 3. On your Android phone
1. Open that address in **Chrome**, tap ⋮ → **Add to Home screen** (or **Install app**).
2. Open GzMail from the home screen and tap ＋ to add your first contact.
3. Google shows a "Google hasn't verified this app" warning. That's expected because it's your own private app. Tap **Continue**, then allow **read** and **send** access.

## Things to know

- **Reconnecting:** Google sign-ins from a web page last 1 hour. After that, the app still opens instantly and shows your saved emails. A banner offers "Tap to check for new mail", and one tap reconnects (usually with no password). If this gets annoying, a small free Cloudflare Worker could keep the connection alive longer.
- **Gaps of a week or more:** Gmail only keeps its change log for about a week. If you don't open the app for longer than that, it automatically re-checks each contact's history, skipping emails it already has.
- **Updates:** when a new version is published, it takes effect the second time you open the app.
- **What counts as a contact's email:** any email where one of their addresses appears in From, To or Cc. Spam, trash and drafts are excluded.
