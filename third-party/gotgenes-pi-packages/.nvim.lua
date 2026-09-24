-- Project-local Neovim config, sourced by klen/nvim-config-local when nvim is
-- opened in this repo. Defines :PkgDiffview, which diffs a single package's
-- working tree against its most recent release tag using Diffview.nvim.
--
-- Tags are <component>-v<version> (release-please: include-component-in-tag +
-- include-v-in-tag). The glob is "<pkg>-v*" (not "<pkg>-*") so pi-subagents
-- does NOT match the sibling pi-subagents-worktrees tags.

local function resolve_latest_tag(pkg)
  local tag = vim.fn.systemlist({
    "git",
    "tag",
    "--list",
    pkg .. "-v*",
    "--sort=-version:refname",
  })[1]
  if vim.v.shell_error ~= 0 or not tag or tag == "" then
    return nil
  end
  return tag
end

vim.api.nvim_create_user_command("PkgDiffview", function(ctx)
  local pkg = ctx.fargs[1]
  if not pkg or pkg == "" then
    vim.notify("PkgDiffview: package name required (e.g. :PkgDiffview pi-subagents)", vim.log.levels.ERROR)
    return
  end

  local dir = "packages/" .. pkg
  if vim.fn.isdirectory(dir) == 0 then
    vim.notify("PkgDiffview: no such package directory: " .. dir, vim.log.levels.ERROR)
    return
  end

  local tag = resolve_latest_tag(pkg)
  if not tag then
    vim.notify("PkgDiffview: no release tag found for " .. pkg, vim.log.levels.ERROR)
    return
  end

  vim.notify(("PkgDiffview: %s vs %s"):format(pkg, tag))
  vim.cmd(("DiffviewOpen %s -- %s"):format(vim.fn.shellescape(tag), dir))
end, {
  nargs = "*",
  complete = function()
    return vim.fn.readdir("packages")
  end,
  desc = "Diff a pi-packages package against its latest release tag (Diffview.nvim)",
})
