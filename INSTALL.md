# INSTALL.md

# Create an EQTY DAO copy of the template repo

This guide explains how to copy the template repository from:

```text
https://github.com/Zolpho/crypto-orderbook-depth-template
```

to the EQTY DAO GitHub organization:

```text
https://github.com/eqty-dao
```

The recommended result is:

```text
https://github.com/eqty-dao/crypto-orderbook-depth-template
```

This new organization-owned repository can then also be marked as a GitHub template, so future EQTY DAO orderbook projects can be created from it.

---

## Prerequisites

You need:

- Access to the `eqty-dao` GitHub organization
- Permission to create repositories inside `eqty-dao`
- Git installed locally
- Optional but recommended: GitHub CLI `gh`

Check GitHub CLI authentication:

```bash
gh auth status
```

If needed:

```bash
gh auth login
```

---

# Option A — Recommended: Create repo from template using GitHub UI

Use this method if you want a clean new repo based on the template files.

## 1. Open the source template

Go to:

```text
https://github.com/Zolpho/crypto-orderbook-depth-template
```

## 2. Click “Use this template”

Click:

```text
Use this template → Create a new repository
```

## 3. Choose the target owner

Set:

```text
Owner: eqty-dao
Repository name: crypto-orderbook-depth-template
Visibility: Public
```

Then click:

```text
Create repository
```

The new repo should be:

```text
https://github.com/eqty-dao/crypto-orderbook-depth-template
```

## 4. Mark the new EQTY DAO repo as a template

Open:

```text
https://github.com/eqty-dao/crypto-orderbook-depth-template
```

Then go to:

```text
Settings → General → Template repository
```

Enable:

```text
Template repository
```

Save the setting.

## 5. Clone the EQTY DAO repo locally

```bash
cd /Users/zol/Github
git clone https://github.com/eqty-dao/crypto-orderbook-depth-template.git
cd crypto-orderbook-depth-template
```

Check the repo:

```bash
git status
git remote -v
ls -la
```

You should see:

```text
origin  https://github.com/eqty-dao/crypto-orderbook-depth-template.git
```

---

# Option B — Create repo from template using GitHub CLI

Use this if you prefer the terminal.

```bash
cd /Users/zol/Github

gh repo create eqty-dao/crypto-orderbook-depth-template \
  --template Zolpho/crypto-orderbook-depth-template \
  --public \
  --clone

cd crypto-orderbook-depth-template
```

Then mark it as a template:

```bash
gh repo edit eqty-dao/crypto-orderbook-depth-template --template=true
```

Check:

```bash
git remote -v
git status
```

---

# Option C — Mirror copy with full Git history

Use this only if you want to preserve the full commit history from the original repo.

First create an empty repo on GitHub:

```text
https://github.com/organizations/eqty-dao/repositories/new
```

Use:

```text
Repository name: crypto-orderbook-depth-template
Visibility: Public
Do not initialize with README, .gitignore, or license
```

Then run:

```bash
cd /tmp

git clone --mirror https://github.com/Zolpho/crypto-orderbook-depth-template.git
cd crypto-orderbook-depth-template.git

git push --mirror https://github.com/eqty-dao/crypto-orderbook-depth-template.git

cd /Users/zol/Github
git clone https://github.com/eqty-dao/crypto-orderbook-depth-template.git
cd crypto-orderbook-depth-template
```

Mark it as template:

```bash
gh repo edit eqty-dao/crypto-orderbook-depth-template --template=true
```

---

# Configure GitHub Pages for projects created from this template

For any actual orderbook project created from this template, for example:

```text
https://github.com/eqty-dao/eqty-gate-orderbook
```

go to:

```text
Settings → Pages
```

Set:

```text
Source: GitHub Actions
```

This is required because the template uses a GitHub Actions workflow to generate `config.js` and deploy GitHub Pages.

---

# Configure repository variables for an orderbook project

For a real project created from the template, go to:

```text
Settings → Secrets and variables → Actions → Variables
```

Add these repository variables:

```text
SITE_TITLE       EQTY/USDT Gate.io Orderbook Depth
DEFAULT_EXCHANGE gate
DEFAULT_PAIR     EQTY_USDT
WORKER_URL       https://gate-orderbook.<your_cloudflare_worker>.workers.dev
REFRESH_SECONDS  30
DEPTH_PERCENT    2
DEFAULT_LIMIT    100
ALLOW_USER_PAIR  true
PIN_DEFAULT_PAIR true
```

These are public frontend settings, so use GitHub Variables, not GitHub Secrets.

---

# Optional Cloudflare deployment secrets

Cloudflare credentials are optional.

You only need these secrets if you want GitHub Actions to deploy the Cloudflare Worker automatically:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

If you deploy the Worker manually in Cloudflare, use Cloudflare Git integration, or use an existing Worker URL, you can skip these secrets.

Never place private exchange API keys, wallet keys, or trading credentials into frontend config.

---

# Test the new organization template

After creating:

```text
https://github.com/eqty-dao/crypto-orderbook-depth-template
```

open it in GitHub and check:

```text
Settings → General → Template repository is enabled
```

Then click:

```text
Use this template → Create a new repository
```

Create a test repo, for example:

```text
eqty-dao/gate-orderbook-test
```

Then enable Pages:

```text
Settings → Pages → Source: GitHub Actions
```

Add repository variables.

Push or re-run the Pages workflow.

The test site should become:

```text
https://eqty-dao.github.io/gate-orderbook-test/
```

---

# Common issues

## Pages workflow fails with “Get Pages site failed”

Fix:

```text
Repo → Settings → Pages → Source: GitHub Actions
```

Then re-run the failed workflow.

## Dashboard loads but API fails with CORS

Make sure the Cloudflare Worker allows the GitHub Pages origin.

For EQTY DAO pages, the origin is usually:

```text
https://eqty-dao.github.io
```

The Worker should include that origin in its allowed origins list.

## Worker limits concern

If someone clones the frontend and keeps your Worker URL, their page may still try to call your Worker.

Protect the Worker by:

- Restricting allowed browser origins
- Rejecting invalid exchange and pair values
- Clamping the `limit` parameter
- Adding short caching if needed
- Adding Cloudflare rate limiting if usage grows

---

# Recommended final structure

Template repo:

```text
https://github.com/eqty-dao/crypto-orderbook-depth-template
```

Example project created from template:

```text
https://github.com/eqty-dao/eqty-gate-orderbook
```

Example live page:

```text
https://eqty-dao.github.io/eqty-gate-orderbook/
```

Example Worker:

```text
https://gate-orderbook.<your_cloudflare_worker>.workers.dev/
```

