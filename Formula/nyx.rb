# Nyx private Homebrew tap formula.
#
# Setup (first time):
#   brew tap dg-lens/nyx ~/Nyx/Core
#   brew install --HEAD dg-lens/nyx/nyx
#
# Daemon management:
#   brew services start dg-lens/nyx/nyx
#   brew services stop  dg-lens/nyx/nyx
#
# NYX_DATA_DIR    (default ~/Nyx/Data)    holds nyx.md, data/, logs/, .env.
# NYX_PLUGINS_DIR (default ~/Nyx/Plugins) holds local (private) plugins.
# NYX_REPO_ROOT   (#{opt_libexec})        holds compiled Core code; set by wrappers.
require "etc"

class Nyx < Formula
  desc "Autonomous task dispatcher with hash-chained audit and MCP integrations"
  homepage "https://github.com/dg-lens/Nyx"
  license "MIT"

  # HEAD-only formula installed from the local Core git repo (the three-sibling
  # layout: ~/Nyx/Core is the git repo; ~/Nyx/Data and ~/Nyx/Plugins are siblings).
  head "file://#{Dir.home}/Nyx/Core", using: :git, branch: "main"

  depends_on "node"
  depends_on "pnpm"

  def install
    # Install Core source to libexec (git-ignored dist/, node_modules/ excluded).
    libexec.install Dir["*"]

    # Install deps and compile all TypeScript workspaces inside libexec.
    cd libexec do
      system "pnpm", "install"
      system "pnpm", "-r", "build"
    end

    # Dir.home inside `def install` is Homebrew's sandbox HOME, not the real
    # user's. Resolve the invoking user's home from the passwd DB instead.
    home_dir = Etc.getpwuid(Process.uid).dir
    data_dir = "#{home_dir}/Nyx/Data"
    plugins_dir = "#{home_dir}/Nyx/Plugins"

    # Wrapper: nyx CLI — points at the libexec code + the sibling Data/Plugins.
    (bin/"nyx").write <<~SH
      #!/bin/bash
      export NYX_REPO_ROOT="#{opt_libexec}"
      export NYX_DATA_DIR="${NYX_DATA_DIR:-$HOME/Nyx/Data}"
      export NYX_PLUGINS_DIR="${NYX_PLUGINS_DIR:-$HOME/Nyx/Plugins}"
      exec "#{opt_libexec}/scripts/nyx" "$@"
    SH
    chmod 0755, bin/"nyx"

    # Wrapper: dispatch entry point — invoked by the launchd plist.
    (bin/"nyx-dispatch.sh").write <<~SH
      #!/bin/bash
      export NYX_REPO_ROOT="#{opt_libexec}"
      export NYX_DATA_DIR="${NYX_DATA_DIR:-$HOME/Nyx/Data}"
      export NYX_PLUGINS_DIR="${NYX_PLUGINS_DIR:-$HOME/Nyx/Plugins}"
      exec "#{opt_libexec}/scripts/nyx-dispatch.sh" "$@"
    SH
    chmod 0755, bin/"nyx-dispatch.sh"

    # Generate launchd plist with real paths — brew services copies this to
    # ~/Library/LaunchAgents/ on `brew services start`.
    (prefix/"com.nyx.dispatcher.plist").write <<~XML
      <?xml version="1.0" encoding="UTF-8"?>
      <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
      <plist version="1.0">
      <dict>
          <key>Label</key>
          <string>com.nyx.dispatcher</string>

          <key>ProgramArguments</key>
          <array>
              <string>#{opt_bin}/nyx-dispatch.sh</string>
          </array>

          <key>WorkingDirectory</key>
          <string>#{data_dir}</string>

          <key>StartCalendarInterval</key>
          <array>
              <dict><key>Minute</key><integer>0</integer></dict>
              <dict><key>Minute</key><integer>5</integer></dict>
              <dict><key>Minute</key><integer>10</integer></dict>
              <dict><key>Minute</key><integer>15</integer></dict>
              <dict><key>Minute</key><integer>20</integer></dict>
              <dict><key>Minute</key><integer>25</integer></dict>
              <dict><key>Minute</key><integer>30</integer></dict>
              <dict><key>Minute</key><integer>35</integer></dict>
              <dict><key>Minute</key><integer>40</integer></dict>
              <dict><key>Minute</key><integer>45</integer></dict>
              <dict><key>Minute</key><integer>50</integer></dict>
              <dict><key>Minute</key><integer>55</integer></dict>
          </array>

          <key>RunAtLoad</key>
          <false/>

          <key>StandardOutPath</key>
          <string>#{data_dir}/logs/launchd.out.log</string>

          <key>StandardErrorPath</key>
          <string>#{data_dir}/logs/launchd.err.log</string>

          <key>EnvironmentVariables</key>
          <dict>
              <key>PATH</key>
              <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
              <key>HOME</key>
              <string>#{home_dir}</string>
              <key>NYX_REPO_ROOT</key>
              <string>#{opt_libexec}</string>
              <key>NYX_DATA_DIR</key>
              <string>#{data_dir}</string>
              <key>NYX_PLUGINS_DIR</key>
              <string>#{plugins_dir}</string>
          </dict>

          <key>ProcessType</key>
          <string>Background</string>

          <key>Nice</key>
          <integer>5</integer>
      </dict>
      </plist>
    XML
  end

  def plist_name
    "com.nyx.dispatcher"
  end

  def caveats
    home_dir = Etc.getpwuid(Process.uid).dir
    data_dir = "#{home_dir}/Nyx/Data"
    plugins_dir = "#{home_dir}/Nyx/Plugins"
    <<~EOS
      Nyx data directory (nyx.md, database, .env, logs):
        #{data_dir}

      Nyx local plugins:
        #{plugins_dir}

      Nyx code installed to:
        #{opt_libexec}

      Manage the dispatcher daemon:
        brew services start dg-lens/nyx/nyx
        brew services stop  dg-lens/nyx/nyx
        brew services list

      Or use the nyx CLI:
        nyx up    # loads the launchd plist directly
        nyx down  # unloads

      To override the data directory:
        export NYX_DATA_DIR=/path/to/data
        nyx up

      Update to latest HEAD (after committing to ~/Nyx/Core):
        brew uninstall nyx && brew install --HEAD dg-lens/nyx/nyx
      (this Homebrew rejects `reinstall --HEAD`; uninstall+install forces a
      rebuild from the new HEAD instead of relinking the old keg.)
    EOS
  end
end
