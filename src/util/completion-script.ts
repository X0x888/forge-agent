/** Shell completion scripts for expert terminals. */
export function shellCompletionScript(shell: string): string {
  const cmds =
    "run login logout auth sessions init models doctor status completion prune-tool-output prune-metrics";
  const zshCmds = cmds.split(" ").join(" ");
  if (shell === "zsh") {
    return [
      "#compdef forge",
      '# Install: forge completion zsh > "${fpath[1]}/_forge" && compinit',
      "_forge() {",
      "  local -a cmds",
      `  cmds=(${zshCmds})`,
      "  _arguments '1:command:->cmds' '*::arg:->args'",
      "  case $state in",
      "    cmds) _describe 'command' cmds ;;",
      "  esac",
      "}",
      "compdef _forge forge",
      "",
    ].join("\n");
  }
  if (shell === "fish") {
    return [
      "# Install: forge completion fish > ~/.config/fish/completions/forge.fish",
      "complete -c forge -f",
      `complete -c forge -n "__fish_use_subcommand" -a "${cmds}"`,
      'complete -c forge -l help -d "Help"',
      'complete -c forge -l version -d "Version"',
      'complete -c forge -l model -d "Model id"',
      'complete -c forge -l provider -d "Provider"',
      'complete -c forge -l permission-mode -d "Permission mode"',
      'complete -c forge -l ulw -d "Ultrawork"',
      'complete -c forge -l json -d "JSON output"',
      'complete -c forge -l new -d "Force a new session (skip same-cwd auto-resume)"',
      'complete -c forge -l session -d "Resume session id/prefix"',
      "",
    ].join("\n");
  }
  // bash
  return [
    '# Install: eval "$(forge completion bash)"',
    "# or: forge completion bash > /usr/local/etc/bash_completion.d/forge",
    "_forge_completions() {",
    '  local cur="${COMP_WORDS[COMP_CWORD]}"',
    `  local cmds="${cmds}"`,
    '  local top_flags="--new --session --model --provider --permission-mode --ulw --goal --cwd --help --version"',
    "  if [[ ${COMP_CWORD} -eq 1 ]]; then",
    '    COMPREPLY=( $(compgen -W "$cmds $top_flags" -- "$cur") )',
    "    return",
    "  fi",
    '  local prev="${COMP_WORDS[1]}"',
    '  case "$prev" in',
    '    sessions) COMPREPLY=( $(compgen -W "list show export import fork delete prune" -- "$cur") ) ;;',
    '    doctor|models|status|auth) COMPREPLY=( $(compgen -W "--json" -- "$cur") ) ;;',
    '    run) COMPREPLY=( $(compgen -W "--json --ulw --permission-mode --model --provider --goal --session --new" -- "$cur") ) ;;',
    '    login) COMPREPLY=( $(compgen -W "--api-key --oauth --device --from-grok --provider" -- "$cur") ) ;;',
    '    completion) COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") ) ;;',
    '    prune-tool-output|prune-metrics) COMPREPLY=( $(compgen -W "--json --keep" -- "$cur") ) ;;',
    '    --new|--session|--model|--provider|--permission-mode|--ulw|--goal|--cwd|--help|--version)',
    '      COMPREPLY=( $(compgen -W "$top_flags" -- "$cur") ) ;;',
    "  esac",
    "}",
    "complete -F _forge_completions forge",
    "",
  ].join("\n");
}
