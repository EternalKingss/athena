// report.mjs — Professional Markdown report generation (Pillar 3)
import { getCachedCapabilities } from './capabilities.mjs';
import { assessThreatSurface, formatThreatReport } from './threat.mjs';
import { handleNetworkScanTool } from './network.mjs';
import { runBootTriage, formatTriageReport } from './triage.mjs';

function systemSection(caps) {
  const lines = ['## System Report', ''];
  const s     = caps.system || {};

  lines.push(`**Platform:** ${process.platform} (${process.arch})`);
  lines.push(`**Node:** ${caps.node || process.version}`);
  if (s.cpuModel) lines.push(`**CPU:** ${s.cpuModel}${s.cpuCores ? ` (${s.cpuCores} cores)` : ''}`);
  if (s.ramTotal) lines.push(`**RAM:** ${s.ramTotal}${s.ramFree ? `, ${s.ramFree}` : ''}`);
  if (s.disks?.length) lines.push(`**Disk:** ${s.disks.join(' | ')}`);
  lines.push('');

  if (caps.gpus?.length) {
    lines.push('### GPUs');
    caps.gpus.forEach(g => lines.push(`  - ${g}`));
    lines.push('');
  }

  const sections = [
    ['Languages',      caps.langs],
    ['Compilers',      caps.compilers],
    ['Package Mgrs',   caps.pkgMgrs],
    ['Containers',     caps.containers],
    ['Databases',      caps.databases],
    ['Browsers',       caps.browsers],
    ['IDEs / Editors', caps.ides],
    ['DevOps / Cloud', caps.devops],
    ['Utilities',      caps.utils],
    ['Security Tools', caps.security],
    ['MCP Servers',    caps.mcp],
  ];
  for (const [label, arr] of sections) {
    if (arr?.length) lines.push(`**${label}:** ${arr.join(', ')}`);
  }
  lines.push('');

  const b = caps.bundled;
  const bundled = [b?.python && 'python (drive)', b?.lokiPy && 'loki (drive)'].filter(Boolean);
  if (bundled.length) lines.push(`**Bundled on drive:** ${bundled.join(', ')}`);

  return lines.join('\n');
}

export async function generateSystemReport() {
  const caps = getCachedCapabilities() || {};
  return ['# Athena System Report', `*${new Date().toLocaleString()}*`, '', systemSection(caps)].join('\n');
}

export async function generateSecurityReport() {
  const [threatResult, triageResult] = await Promise.allSettled([assessThreatSurface(), runBootTriage()]);
  const threatSection = threatResult.status === 'fulfilled'
    ? formatThreatReport(threatResult.value)
    : `## Threat Surface Assessment\n\n⚠ Failed to assess: ${threatResult.reason?.message || 'unknown error'}`;
  const triageSection = triageResult.status === 'fulfilled'
    ? formatTriageReport(triageResult.value)
    : `## Boot Triage\n\n⚠ Failed to run: ${triageResult.reason?.message || 'unknown error'}`;
  return [
    '# Athena Security Report',
    `*${new Date().toLocaleString()}*`,
    '',
    threatSection,
    triageSection,
  ].join('\n');
}

export async function generateNetworkReport() {
  const network = await handleNetworkScanTool({ deep: false });
  return ['# Athena Network Report', `*${new Date().toLocaleString()}*`, '', network].join('\n');
}

export async function generateFullReport() {
  const labels = ['System', 'Security', 'Network'];
  const results = await Promise.allSettled([
    generateSystemReport(),
    generateSecurityReport(),
    generateNetworkReport(),
  ]);
  return results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return `# Athena ${labels[i]} Report\n\n⚠ Failed to generate: ${r.reason?.message || 'unknown error'}`;
  }).join('\n\n---\n\n');
}

export async function handleReportTool(args) {
  const type = (args?.type || 'system').toLowerCase();
  if (type === 'security') return generateSecurityReport();
  if (type === 'network')  return generateNetworkReport();
  if (type === 'full')     return generateFullReport();
  return generateSystemReport();
}
