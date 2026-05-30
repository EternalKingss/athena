---
name: dev-setup
description: Set up a development environment on a new machine — Node, Python, Git, essentials
---

# Dev Environment Setup

## 1. Check what's already installed
```bash
node --version; npm --version
python3 --version; pip3 --version
git --version
code --version 2>/dev/null || echo "VSCode not found"
```

## 2. Git config (do this first on any new machine)
```bash
git config --global user.name "Young Master"
git config --global user.email "your@email.com"
git config --global init.defaultBranch main
git config --global pull.rebase false
```

## 3. Node.js (if missing)
```bash
# Linux
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Or use nvm for version management
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
nvm install 22 && nvm use 22
```

## 4. Python tools (if missing)
```bash
sudo apt install python3-pip python3-venv -y
pip3 install --upgrade pip
```

## 5. Useful CLI tools
```bash
sudo apt install -y git curl wget jq tree htop net-tools
```

## 6. SSH key (if needed for GitHub)
```bash
ssh-keygen -t ed25519 -C "your@email.com"
cat ~/.ssh/id_ed25519.pub   # copy this to GitHub Settings → SSH keys
ssh -T git@github.com       # test it
```

## 7. Verify everything
```bash
node --version && python3 --version && git --version && echo "All good"
```
