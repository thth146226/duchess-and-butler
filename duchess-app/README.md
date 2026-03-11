# Duchess & Butler — Event Supply Management Platform

## 🚀 Setup Instructions

### STEP 1 — Supabase Database

1. Go to **supabase.com** → open your project `duchess-and-butler`
2. Click **SQL Editor** → **New Query**
3. Copy the entire contents of `SUPABASE_SETUP.sql` and paste it
4. Click **Run** — you should see "Success"

### STEP 2 — Create your Admin user

1. In Supabase, go to **Authentication → Users → Add User**
2. Enter your email and a password → click **Create User**
3. Copy the **User UID** shown
4. Go to **SQL Editor** and run:
```sql
insert into public.users (id, name, role)
values ('PASTE-UID-HERE', 'Your Name', 'admin');
```

### STEP 3 — Upload code to GitHub

1. Go to **github.com/your-username/duchess-and-butler**
2. Upload all files from this folder (drag & drop or use GitHub Desktop)

### STEP 4 — Deploy on Vercel

1. Go to **vercel.com** → **Add New Project**
2. Import your `duchess-and-butler` GitHub repo
3. Vercel will auto-detect React — click **Deploy**
4. Your platform will be live at `https://duchess-and-butler.vercel.app`

---

## 👥 Adding Team Members

1. Go to Supabase → **Authentication → Users → Add User**
2. Enter their email and a temporary password
3. Copy their UID and run:
```sql
-- For a driver:
insert into public.users (id, name, role)
values ('THEIR-UID', 'Tom Richards', 'driver');

-- For operations:
insert into public.users (id, name, role)
values ('THEIR-UID', 'Emma Thompson', 'operations');
```
4. Send them the Vercel URL and their temporary password

---

## 📁 Project Structure

```
src/
  contexts/AuthContext.js   — Login state & session
  lib/supabase.js           — Database connection
  pages/
    Login.js                — Sign in screen
    Dashboard.js            — Overview & stats
    Orders.js               — Full order management (CRUD)
    Placeholders.js         — Schedule, Inventory, etc. (Phase 3 & 4)
  components/
    Sidebar.js              — Navigation (role-aware)
  App.js                    — Main app & routing
```

---

## 🔐 Roles

| Role | Access |
|------|--------|
| `admin` | Everything |
| `operations` | Orders, Schedule, Inventory, Paperwork |
| `driver` | Schedule only (their assigned runs) |
