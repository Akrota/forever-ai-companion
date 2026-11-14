// Forever AI Companion: icon next to the Windows clock (notification area).
// Compiled on the player's PC with the C# compiler that ships with Windows
// (see src/tray.js) and run by the app, which talks to it line by line:
// Arguments: icon path, then the texts (base64 of "key=value" lines; see tray.js).
//   app -> tray (stdin):  "ask"            show "keep running or close?"
//                         "balloon <text>" small notice next to the icon
//   tray -> app (stdout): "open" | "quit" | "choice tray 0|1" | "choice quit 0|1"
// When the app exits its end of stdin closes and the icon goes away with it.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("Forever AI Companion")]
[assembly: AssemblyProduct("Forever AI Companion")]
[assembly: AssemblyVersion("1.0.0.0")]

static class Program {
  const string Name = "Forever AI Companion";
  static NotifyIcon icon;
  static Control ui;
  static Icon appIcon;
  static bool asking;

  // English defaults; the app sends the texts in its language.
  static readonly Dictionary<string, string> T = new Dictionary<string, string> {
    { "running", Name + ": running" },
    { "open", "Open " + Name },
    { "close", "Close " + Name },
    { "stillRunning", Name + " is still running" },
    { "clickHint", "Click this icon to open it, or right-click to close it." },
    { "askTitle", "Keep it running?" },
    { "askText", "If it keeps running in the background, you can keep asking from the game. You will find it next to the Windows clock: click its icon to open it again.\n\nIf you close it, the game will not get answers until you open it again." },
    { "remember", "Remember my choice" },
    { "keep", "Keep running in the background" },
    { "quit", "Close the app" },
  };

  static void LoadTexts(string b64) {
    try {
      string all = Encoding.UTF8.GetString(Convert.FromBase64String(b64));
      foreach (string line in all.Split('\n')) {
        int eq = line.IndexOf('=');
        if (eq <= 0) continue;
        T[line.Substring(0, eq)] = line.Substring(eq + 1).Replace("\\n", "\n").Replace("\\\\", "\\");
      }
    } catch { }
  }

  [STAThread]
  static void Main(string[] args) {
    Application.EnableVisualStyles();
    Application.SetCompatibleTextRenderingDefault(false);
    string iconPath = args.Length > 0 ? args[0] : null;
    if (args.Length > 1) LoadTexts(args[1]);
    try { appIcon = iconPath != null && File.Exists(iconPath) ? new Icon(iconPath, SystemInformation.SmallIconSize) : SystemIcons.Application; }
    catch { appIcon = SystemIcons.Application; }

    ui = new Control();
    ui.CreateControl();

    var menu = new ContextMenuStrip();
    var open = new ToolStripMenuItem(T["open"], null, (s, e) => Send("open"));
    open.Font = new Font(open.Font, FontStyle.Bold);
    menu.Items.Add(open);
    menu.Items.Add(new ToolStripSeparator());
    menu.Items.Add(new ToolStripMenuItem(T["close"], null, (s, e) => Send("quit")));

    icon = new NotifyIcon();
    icon.Icon = appIcon;
    icon.Text = T["running"].Length > 63 ? T["running"].Substring(0, 63) : T["running"];
    icon.ContextMenuStrip = menu;
    icon.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) Send("open"); };
    icon.BalloonTipClicked += (s, e) => Send("open");
    icon.Visible = true;

    var reader = new Thread(ReadCommands);
    reader.IsBackground = true;
    reader.Start();

    Application.Run();
    icon.Visible = false;
    icon.Dispose();
  }

  static void Send(string line) {
    try { Console.Out.WriteLine(line); Console.Out.Flush(); } catch { }
  }

  static void ReadCommands() {
    string line;
    try {
      while ((line = Console.In.ReadLine()) != null) {
        string cmd = line.Trim();
        if (cmd == "ask") ui.BeginInvoke((Action)Ask);
        else if (cmd.StartsWith("balloon ")) {
          string text = cmd.Substring(8);
          ui.BeginInvoke((Action)(() => icon.ShowBalloonTip(6000, T["stillRunning"], text, ToolTipIcon.Info)));
        }
      }
    } catch { }
    // The app closed: remove the icon and exit.
    ui.BeginInvoke((Action)(() => { icon.Visible = false; Application.Exit(); }));
  }

  // "Keep running in the background, or close the app?"
  static void Ask() {
    if (asking) return;
    asking = true;
    var f = new Form();
    f.Text = Name;
    f.Icon = appIcon;
    f.FormBorderStyle = FormBorderStyle.FixedDialog;
    f.MaximizeBox = false; f.MinimizeBox = false;
    f.StartPosition = FormStartPosition.CenterScreen;
    f.TopMost = true;
    f.ShowInTaskbar = true;
    f.Font = new Font("Segoe UI", 10f);
    f.BackColor = Color.White;
    f.AutoSize = true;
    f.AutoSizeMode = AutoSizeMode.GrowAndShrink;

    // Everything stacked and sized by its content, so any Windows scaling fits.
    var layout = new TableLayoutPanel();
    layout.ColumnCount = 1;
    layout.AutoSize = true;
    layout.AutoSizeMode = AutoSizeMode.GrowAndShrink;
    layout.Padding = new Padding(18, 14, 18, 14);
    layout.Dock = DockStyle.Fill;

    var title = new Label();
    title.Text = T["askTitle"];
    title.Font = new Font("Segoe UI Semibold", 13f);
    title.ForeColor = Color.FromArgb(20, 28, 60);
    title.AutoSize = true;
    title.Margin = new Padding(0, 0, 0, 8);

    var text = new Label();
    text.Text = T["askText"];
    text.ForeColor = Color.FromArgb(70, 75, 90);
    text.AutoSize = true;
    text.MaximumSize = new Size(440, 0);
    text.Margin = new Padding(0, 0, 0, 12);

    var remember = new CheckBox();
    remember.Text = T["remember"];
    remember.AutoSize = true;
    remember.Margin = new Padding(0, 0, 0, 14);

    var buttons = new FlowLayoutPanel();
    buttons.FlowDirection = FlowDirection.RightToLeft;
    buttons.AutoSize = true;
    buttons.AutoSizeMode = AutoSizeMode.GrowAndShrink;
    buttons.Dock = DockStyle.Fill;
    buttons.Margin = new Padding(0);
    buttons.WrapContents = false;

    var keep = new Button();
    keep.Text = T["keep"];
    keep.AutoSize = true;
    keep.Padding = new Padding(10, 4, 10, 4);
    keep.BackColor = Color.FromArgb(63, 111, 230);
    keep.ForeColor = Color.White;
    keep.FlatStyle = FlatStyle.Flat;
    keep.FlatAppearance.BorderSize = 0;
    keep.Margin = new Padding(8, 0, 0, 0);

    var close = new Button();
    close.Text = T["quit"];
    close.AutoSize = true;
    close.Padding = new Padding(8, 4, 8, 4);
    close.FlatStyle = FlatStyle.System;
    close.Margin = new Padding(0);

    buttons.Controls.Add(keep);
    buttons.Controls.Add(close);
    layout.Controls.Add(title);
    layout.Controls.Add(text);
    layout.Controls.Add(remember);
    layout.Controls.Add(buttons);
    f.Controls.Add(layout);
    string choice = null;
    keep.Click += (s, e) => { choice = "tray"; f.Close(); };
    close.Click += (s, e) => { choice = "quit"; f.Close(); };
    f.AcceptButton = keep;
    f.FormClosed += (s, e) => {
      asking = false;
      if (choice == null) return; // closed with the X: keep running, nothing to remember
      Send("choice " + choice + " " + (remember.Checked ? "1" : "0"));
      if (choice == "tray") icon.ShowBalloonTip(6000, T["stillRunning"], T["clickHint"], ToolTipIcon.Info);
    };
    f.Show();
    f.Activate();
    keep.Focus();
  }
}
