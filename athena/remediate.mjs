// remediate.mjs — Guided remediation playbooks for common security issues (Pillar 2)

const PLAYBOOKS = {
  firewall: {
    linux: {
      check:   'systemctl is-active ufw 2>/dev/null || grep -i "^ENABLED=" /etc/ufw/ufw.conf 2>/dev/null',
      steps:   ['sudo ufw default deny incoming', 'sudo ufw default allow outgoing', 'sudo ufw allow ssh', 'sudo ufw --force enable'],
      explain: 'Enables UFW firewall — blocks all inbound traffic except SSH.',
    },
    darwin: {
      check:   '/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate',
      steps:   ['sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate on'],
      explain: 'Enables the macOS application firewall.',
    },
    win32: {
      check:   'netsh advfirewall show allprofiles state',
      steps:   ['netsh advfirewall set allprofiles state on'],
      explain: 'Enables Windows Firewall for all network profiles.',
    },
  },
  ssh: {
    linux: {
      check:   'grep -E "^PermitRootLogin|^PasswordAuthentication" /etc/ssh/sshd_config',
      steps:   [
        "sudo sed -i 's/^#\\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config",
        "sudo sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config",
        'sudo systemctl restart sshd 2>/dev/null || sudo service ssh restart',
      ],
      explain: 'Disables root login and password authentication over SSH. Key-based auth is required.',
    },
  },
  fail2ban: {
    linux: {
      check:   'fail2ban-client status 2>/dev/null | head -3',
      steps:   ['sudo systemctl enable fail2ban', 'sudo systemctl start fail2ban'],
      explain: 'Enables and starts fail2ban to auto-ban repeated failed SSH logins.',
    },
  },
  clamav: {
    linux: {
      check:   'clamscan --version 2>/dev/null || echo "not installed"',
      steps:   ['sudo apt-get install -y clamav clamav-daemon', 'sudo freshclam', 'sudo systemctl enable clamav-daemon', 'sudo systemctl start clamav-daemon'],
      explain: 'Installs ClamAV antivirus, updates virus definitions, and starts the daemon.',
    },
  },
  updates: {
    linux: {
      check:   'apt list --upgradable 2>/dev/null | tail -n +2 | wc -l',
      steps:   ['sudo apt-get update -y', 'sudo apt-get upgrade -y --with-new-pkgs', 'sudo apt-get autoremove -y'],
      explain: 'Updates all installed packages to their latest versions.',
    },
    darwin: {
      check:   'softwareupdate -l 2>/dev/null | head -10',
      steps:   ['sudo softwareupdate -ia'],
      explain: 'Installs all available macOS software updates.',
    },
    win32: {
      check:   'wmic qfe list brief /format:table 2>nul | tail -5',
      steps:   ['powershell -Command "Install-Module PSWindowsUpdate -Force; Import-Module PSWindowsUpdate; Install-WindowsUpdate -AcceptAll -AutoReboot"'],
      explain: 'Installs all pending Windows updates (requires restart).',
    },
  },
  disk: {
    linux: {
      check:   'df -h /',
      steps:   ['sudo journalctl --vacuum-time=7d', 'sudo apt-get clean -y', 'sudo apt-get autoremove -y'],
      explain: 'Cleans journal logs older than 7 days and removes unused package cache.',
    },
    darwin: {
      check:   'df -h /',
      steps:   ['brew cleanup --prune=7 2>/dev/null || true'],
      explain: 'Removes Homebrew caches older than 7 days.',
    },
    win32: {
      check:   'wmic logicaldisk get Caption,FreeSpace,Size /format:list 2>nul',
      steps:   ['cleanmgr /sagerun:1'],
      explain: 'Runs Windows Disk Cleanup in unattended mode.',
    },
  },
  suid: {
    linux: {
      check:   'find /usr /bin /sbin -perm /4000 -type f 2>/dev/null',
      steps:   [],
      explain: 'SUID binaries must be reviewed case-by-case. Use "sudo chmod u-s <path>" to remove the SUID bit from unnecessary binaries.',
    },
  },
};

function matchPlaybook(issue) {
  if (!issue) return null;
  const lower = issue.toLowerCase();
  if (/firewall|ufw|iptables|nftables/i.test(lower))  return PLAYBOOKS.firewall;
  if (/ssh|sshd|root login|password.*auth/i.test(lower)) return PLAYBOOKS.ssh;
  if (/fail2ban/i.test(lower))                          return PLAYBOOKS.fail2ban;
  if (/clam|antivirus|clamav|av\b/i.test(lower))       return PLAYBOOKS.clamav;
  if (/update|upgrade|patch|outdated/i.test(lower))    return PLAYBOOKS.updates;
  if (/disk|space|storage|full\b/i.test(lower))        return PLAYBOOKS.disk;
  if (/suid|setuid/i.test(lower))                       return PLAYBOOKS.suid;
  return null;
}

export function getRemediationPlan(issue) {
  const pb   = matchPlaybook(issue);
  const plat = process.platform;

  if (!pb) {
    return {
      found:   false,
      message: `No automated playbook for: "${issue}". Use run_shell with specific commands, or ask Athena to search for the fix.`,
    };
  }

  // Don't fall back to Linux steps on Windows/Mac — wrong package managers, no sudo, etc.
  const plan = pb[plat] || (plat === 'linux' ? pb['linux'] : null);
  if (!plan) {
    return {
      found:   false,
      message: `No automated playbook for "${issue}" on ${plat}. Use run_shell with platform-appropriate commands or ask Athena to look it up.`,
    };
  }

  return {
    found:   true,
    check:   plan.check,
    steps:   plan.steps,
    explain: plan.explain,
    issue,
    platform: plat,
  };
}
