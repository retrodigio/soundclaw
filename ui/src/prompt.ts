// The text a person copies to start an agent on the open requests.

export function shownDir(dir: string, home?: string): string {
  return home && dir.startsWith(home + '/') ? '~' + dir.slice(home.length) : dir;
}

export function promptFor(dir: string): string {
  return `Work the open requests in the SoundClaw project ${dir}: run \`soundclaw work ${dir} list\`, claim one with \`soundclaw work ${dir} claim\`, change the sound as asked, then finish with \`soundclaw work ${dir} done "<what changed>"\`. Keep \`soundclaw await ${dir}\` running in the background so my next requests reach you.`;
}
