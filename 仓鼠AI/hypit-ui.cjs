// Development-only entry markup; excluded from public distributions.
const parts={
  "STYLE": "<link rel=\"stylesheet\" href=\"/hypit.css\" />",
  "BUTTON": "<button class=\"rail-item\" id=\"hypitButton\" data-view=\"hypit\" type=\"button\" hidden><span class=\"rail-icon\"><i data-lucide=\"clapperboard\"></i></span><span>Hypit</span></button>",
  "PANEL": "<section class=\"view hypit-view\" data-panel=\"hypit\"><div id=\"hypitWorkspace\"></div></section>",
  "SCRIPT": "<script type=\"module\" src=\"/hypit-launch.mjs\"></script>"
};
module.exports=html=>Object.entries(parts).reduce((value,[key,markup])=>value.replace('<!-- INTERNAL_'+key+' -->',markup),html);
