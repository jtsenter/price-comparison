# Setup Guide — PriceWatch

## What you need
- A free GitHub account
- Git installed on your computer (https://git-scm.com)

---

## Step 1 — Create a GitHub repository

1. Go to github.com and sign in
2. Click **New repository**
3. Name it `price-comparison`
4. Set it to **Public** (required for free GitHub Pages)
5. Do NOT tick "Add a README" — leave it empty
6. Click **Create repository**

---

## Step 2 — Upload the project

Open a terminal (Command Prompt or PowerShell) and run:

```
cd C:\Users\jtsen\Desktop\price-comparison
git init
git add .
git commit -m "initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/price-comparison.git
git push -u origin main
```

Replace `YOUR_USERNAME` with your actual GitHub username.

---

## Step 3 — Enable GitHub Pages

1. In your repo on GitHub, go to **Settings → Pages**
2. Under **Source**, select **Deploy from a branch**
3. Branch: `main`, Folder: `/docs`
4. Click **Save**

After about 1 minute, your site will be live at:
`https://YOUR_USERNAME.github.io/price-comparison`

---

## Step 4 — Create a Personal Access Token (for the Refresh button)

1. Go to **GitHub → Settings → Developer Settings → Personal access tokens → Fine-grained tokens**
2. Click **Generate new token**
3. Name it `PriceWatch Refresh`
4. Set expiry to 1 year
5. Under **Repository access**, select **Only select repositories** → choose `price-comparison`
6. Under **Permissions**, set **Actions** → **Read and write**
7. Click **Generate token** and copy it (you won't see it again)

---

## Step 5 — Configure the website

1. Open your live site: `https://YOUR_USERNAME.github.io/price-comparison`
2. Click **⚙ Settings** in the top right
3. Enter:
   - GitHub Username: your username
   - Repository Name: `price-comparison`
   - Personal Access Token: the token from Step 4
4. Click **Save**

The **Refresh Now** button will now work.

---

## Step 6 — Run your first refresh

Click **Refresh Now** on the website. It will:
1. Trigger a GitHub Actions job
2. The scraper searches Woolworths and Coles for each item in your shopping list
3. Results are saved and the page reloads automatically (~5–15 minutes)

After that, it runs automatically every **Monday and Thursday at 8am AEST**.

---

## Updating your shopping list

Your shopping list is automatically derived from `shopping_list.xlsx` — any item purchased in the last 90 days appears on the list.

To update it:
1. Replace `shopping_list.xlsx` in the repo with your updated file (same format: sheets `Data` and `Pivot`, columns `Item`, `Unit price`, `Qty`, `Price`, `Date`)
2. Commit and push, or upload via GitHub's web interface
3. The next scrape run will pick up the new list

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Refresh button says "error 401" | Token is wrong or expired — create a new one in Step 4 |
| Refresh button says "error 403" | Token doesn't have Actions write permission |
| Items show "Not found" | Product name not matched — try editing the item name in the Excel to be more generic |
| Site shows old data | Check the Actions tab in GitHub to see if the last run succeeded |
| Scraper blocked by retailer | This can happen occasionally — try again in a few hours |
