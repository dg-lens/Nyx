# Nyx private Homebrew tap formula.
#
# Setup (first time):
#   brew tap OWNER/nyx ~/Nyx
#   brew install --HEAD OWNER/nyx/nyx
#
# Daemon management:
#   brew services start OWNER/nyx/nyx
#   brew services stop  OWNER/nyx/nyx
#
# NYX_DATA_DIR (default ~/Nyx) holds nyx.md, data/, logs/, .env.
# NYX_REPO_ROOT (#{opt_libexec}) holds compiled code; set by generated wrappers.
class Nyx < Formula
  desc "Autonomous task dispatcher with hash-chained audit and MCP integrations"
  homepage "https://github.com/OWNER/nyx"
  license "MIT"

  # HEAD-only formula: installed from the local git repo.
  # Install with: brew install --HEAD OWNER/nyx/nyx
  head "https://github.com/OWNER/nyx.git", using: :git

  depends_on "node"
  depends_on "pnpm"

  def install
    # Install all source to libexec (excludes git-ignored files: dist/, node_modules/)
    libexec.install Dir["*"]

    # Install deps and compile all TypeScript workspaces inside libexec
    cd libexec do
      system "pnpm", "install"
      system "pnpm", "-r", "build"
    end

    data_dir = "#{Dir.home}/Nyx"
    home_dir = Dir.home

    # Wrapper: nyx CLI — sets NYX_REPO_ROOT so scripts/ find compiled code
    (bin/"nyx").write <<~SH
      #!/bin/bash
      export NYX_REPO_ROOT="#{opt_libexec}"
      export NYX_DATA_DIR="${NYX_DATA_DIR:-#{data_dir}}"
      exec "#{opt_libexec}/scripts/nyx" "$@"
    SH
    chmod 0755, bin/"nyx"

    # Wrapper: dispatch entry point — invoked by launchd plist ProgramArguments
    (bin/"nyx-dispatch.sh").write <<~SH
      #!/bin/bash
      export NYX_REPO_ROOT="#{opt_libexec}"
      export NYX_DATA_DIR="${NYX_DATA_DIR:-#{data_dir}}"
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

          <!-- Wall-clock-aligned to the 96-slot grid (00:00, 00:15, 00:30, 00:45 each hour) -->
          <key>StartCalendarInterval</key>
          <array>
              <dict><key>Minute</key><integer>0</integer></dict>
              <dict><key>Minute</key><integer>15</integer></dict>
              <dict><key>Minute</key><integer>30</integer></dict>
              <dict><key>Minute</key><integer>45</integer></dict>
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
    data_dir = "#{Dir.home}/Nyx"
    <<~EOS
      Nyx data directory (nyx.md, database, .env, logs):
        #{data_dir}

      Nyx code installed to:
        #{opt_libexec}

      Manage the dispatcher daemon:
        brew services start OWNER/nyx/nyx
        brew services stop  OWNER/nyx/nyx
        brew services list

      Or use the nyx CLI:
        nyx up    # loads the launchd plist directly
        nyx down  # unloads

      To override the data directory:
        export NYX_DATA_DIR=/path/to/data
        nyx up

      Update to latest HEAD:
        brew reinstall --HEAD OWNER/nyx/nyx
    EOS
  end
end
