// remediate.mjs — Guided remediation playbooks for common security issues (Pillar 2)

const PLAYBOOKS = {
  firewall: {
    linux: {
      check:   'ufw status',
      steps:   ['ufw default deny incoming', 'ufw default allow outgoing', 'ufw allow ssh', 'ufw --force enable'],
      explain: 'Enables UFW firewall — blocks all inbound traffic except SSH.',
    },
    darwin: {
      check:   '/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate',
      steps:   ['/usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate on'],
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
        "sed -i 's/^#\\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config",
        "sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config",
        'systemctl restart sshd 2>/dev/null || service ssh restart',
      ],
      explain: 'Disables root login and password authentication over SSH. Key-based auth is required.',
    },
  },
  fail2ban: {
    linux: {
      check:   'fail2ban-client status 2>/dev/null | head -3',
      steps:   ['systemctl enable fail2ban', 'systemctl start fail2ban'],
      explain: 'Enables and starts fail2ban to auto-ban repeated failed SSH logins.',
    },
  },
  clamav: {
    linux: {
      check:   'clamscan --version 2>/dev/null || echo "not installed"',
      steps:   ['apt-get install -y clamav clamav-daemon', 'freshclam', 'systemctl enable clamav-daemon', 'systemctl start clamav-daemon'],
      explain: 'Installs ClamAV antivirus, updates virus definitions, and starts the daemon.',
    },
  },
  updates: {
    linux: {
      check:   'apt list --upgradable 2>/dev/null | tail -n +2 | wc -l',
      steps:   ['apt-get update -y', 'apt-get upgrade -y --with-new-pkgs', 'apt-get autoremove -y'],
      explain: 'Updates all installed packages to their latest versions.',
    },
    darwin: {
      check:   'softwareupdate -l 2>/dev/null | head -10',
      steps:   ['softwareupdate -ia'],
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
      steps:   ['journalctl --vacuum-time=7d', 'apt-get clean -y', 'apt-get autoremove -y'],
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
      steps:   [], // SUID removal is binary-specific — return guidance instead
      explain: 'SUID binaries must be reviewed case-by-case. Use "chmod u-s <path>" to remove the SUID bit from unnecessary binaries.',
    },
  },
};

function matchPlaybook(issue) {
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
  const plan = pb?.[plat] || pb?.['linux'];

  if (!plan) {
    return {
      found:   false,
      message: `No automated playbook for: "${issue}". Use run_shell with specific commands, or ask Athena to search for the fix.`,
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
