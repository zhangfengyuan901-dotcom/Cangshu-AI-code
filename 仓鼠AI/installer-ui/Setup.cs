using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Microsoft.Win32;

namespace HamsterSetup {
 internal sealed class SetupFailure : Exception {
  internal readonly int Code;
  internal SetupFailure(int code,string text):base(text){Code=code;}
 }
 internal sealed class InstallProgress {
  internal string Stage;
  internal double Percent;
  internal bool Indeterminate,EngineStarted;
  internal InstallProgress(string stage,double percent,bool indeterminate,bool engineStarted){Stage=stage;Percent=percent;Indeterminate=indeterminate;EngineStarted=engineStarted;}
 }
 internal static class InstallCore {
  internal const string ProductGuid="ccdefc5f-4344-55e2-848f-c386cf81f44f";
  internal const string Executable="仓鼠AI.exe";
  internal static string AttemptedDirectory;
  static readonly JavaScriptSerializer Json=new JavaScriptSerializer();
  internal static Dictionary<string,object> ReadJson(string path){
   FileInfo info=new FileInfo(path);if(!info.Exists||info.Length>16384)throw new SetupFailure(30,"安装文件尚未准备完成，请重试。");
   return Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(path));
  }
  internal static string RegistryValue(RegistryHive hive,string suffix,string name){
   using(RegistryKey root=RegistryKey.OpenBaseKey(hive,RegistryView.Registry64))using(RegistryKey key=root.OpenSubKey(suffix)){return key==null?null:key.GetValue(name) as string;}
  }
  internal static string ExistingDirectory(){return RegistryValue(RegistryHive.CurrentUser,"Software\\"+ProductGuid,"InstallLocation");}
  internal static string DefaultDirectory(){return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Programs","仓鼠AI");}
  internal static bool SamePath(string a,string b){try{return String.Equals(Path.GetFullPath(a).TrimEnd('\\'),Path.GetFullPath(b).TrimEnd('\\'),StringComparison.OrdinalIgnoreCase);}catch{return false;}}
  internal static string NormalizeDirectory(string value){
   if(String.IsNullOrWhiteSpace(value)||value.Length>180||value.IndexOfAny(new char[]{'\0','\r','\n','"','*','?','<','>','|'})>=0)throw new SetupFailure(10,"请选择有效的本机安装目录，路径长度不超过180个字符。");
   value=value.Trim();if(value.Length<4||!Char.IsLetter(value[0])||value[1]!=':'||(value[2]!='\\'&&value[2]!='/')||value.Substring(2).Contains(":"))throw new SetupFailure(10,"请选择本机磁盘中的完整安装目录。");
   foreach(string part in value.Substring(3).Split(new char[]{'\\','/'},StringSplitOptions.RemoveEmptyEntries))if(part.EndsWith(".",StringComparison.Ordinal)||part.EndsWith(" ",StringComparison.Ordinal)||part==".."){throw new SetupFailure(10,"安装目录中不能包含上级跳转、尾随空格或句点。");}
   string target=Path.GetFullPath(value).TrimEnd('\\');string volume=Path.GetPathRoot(target).TrimEnd('\\');
   if(SamePath(target,volume+"\\"))throw new SetupFailure(10,"请在磁盘中选择一个独立的应用文件夹。");
   string windows=Environment.GetFolderPath(Environment.SpecialFolder.Windows);
   if(SamePath(target,windows)||target.StartsWith(windows.TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase))throw new SetupFailure(10,"不能将应用安装在Windows系统目录中。");
   foreach(string common in new string[]{Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86)})if(!String.IsNullOrEmpty(common)&&SamePath(target,common))throw new SetupFailure(10,"请选择独立的应用文件夹，避免与已有文件混放。");
   if(File.Exists(target))throw new SetupFailure(10,"该位置是文件，请选择文件夹。");RejectLinks(target);return target;
  }
  internal static void RejectLinks(string target){
   for(DirectoryInfo current=new DirectoryInfo(target);current!=null;current=current.Parent)if(current.Exists&&(current.Attributes&FileAttributes.ReparsePoint)!=0)throw new SetupFailure(10,"请选择不经过目录链接的本机安装位置。");
  }
  static bool KnownProduct(string target){
   string exe=Path.Combine(target,Executable);if(!File.Exists(exe))return false;
   try{return FileVersionInfo.GetVersionInfo(exe).ProductName=="仓鼠AI";}catch{return false;}
  }
  internal static void ValidateOwnership(string target){
   if(!Directory.Exists(target)||!Directory.EnumerateFileSystemEntries(target).Any())return;
   string installed=ExistingDirectory();if(SamePath(target,AttemptedDirectory)||SamePath(target,installed)&&KnownProduct(target))return;
   throw new SetupFailure(11,"该目录已有其他文件。请选择空文件夹，或使用已安装的仓鼠AI目录。");
  }
  internal static void CheckRunning(){
   Process[] processes;try{processes=Process.GetProcessesByName(Path.GetFileNameWithoutExtension(Executable));}catch{throw new SetupFailure(21,"暂时无法检查应用运行状态，请稍后重试。");}
   bool running=processes.Length>0;foreach(Process process in processes)process.Dispose();if(running)throw new SetupFailure(20,"仓鼠AI正在运行。请先保存工作并退出仓鼠AI，再点击重试。");
  }
  internal static void Preflight(string target){
   NormalizeDirectory(target);ValidateOwnership(target);CheckRunning();
   string temp=Path.GetTempPath();RejectLinks(temp);
   DriveInfo installDrive=new DriveInfo(Path.GetPathRoot(target)),tempDrive=new DriveInfo(Path.GetPathRoot(temp));
   long temporary=BuildInfo.BackendSize+64L*1024*1024;
   long needed=BuildInfo.RequiredInstallBytes+(String.Equals(installDrive.Name,tempDrive.Name,StringComparison.OrdinalIgnoreCase)?temporary:0);
   if(!installDrive.IsReady||installDrive.AvailableFreeSpace<needed||!tempDrive.IsReady||tempDrive.AvailableFreeSpace<temporary)throw new SetupFailure(12,"磁盘可用空间不足。请释放空间，或选择其他磁盘后重试。");
   string parent=target;while(!Directory.Exists(parent)){DirectoryInfo previous=Directory.GetParent(parent);if(previous==null)throw new SetupFailure(10,"安装目录无效。");parent=previous.FullName;}
   string probe=Path.Combine(parent,".hamster-setup-probe-"+Guid.NewGuid().ToString("N"));
   try{using(FileStream file=new FileStream(probe,FileMode.CreateNew,FileAccess.Write,FileShare.None)){file.WriteByte(0);}}catch{throw new SetupFailure(13,"该目录不可写。请选择当前用户有写入权限的文件夹。");}finally{try{File.Delete(probe);}catch{}}
  }
  static string HashFile(string file){using(SHA256 hash=SHA256.Create())using(FileStream stream=new FileStream(file,FileMode.Open,FileAccess.Read,FileShare.Read)){return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-","").ToLowerInvariant();}}
  internal static string CurrentStage(string target){try{object value;if(ReadJson(Path.Combine(target,"resources","installed-runtime.json")).TryGetValue("state",out value)&&Convert.ToString(value,CultureInfo.InvariantCulture)=="preparing")return "runtime";}catch{}return "install";}
  internal static void Verify(string target){
   string exe=Path.Combine(target,Executable),resources=Path.Combine(target,"resources");
   if(!File.Exists(exe)||!SamePath(ExistingDirectory(),target))throw new SetupFailure(30,"安装尚未完成，请重试安装。");
   string installedVersion=RegistryValue(RegistryHive.CurrentUser,"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\"+ProductGuid,"DisplayVersion");
   if(installedVersion!=BuildInfo.Version)throw new SetupFailure(30,"应用版本验证未完成，请重试安装。");
   Version actual,expected;if(!Version.TryParse(FileVersionInfo.GetVersionInfo(exe).ProductVersion,out actual)||!Version.TryParse(BuildInfo.Version,out expected)||actual.Major!=expected.Major||actual.Minor!=expected.Minor||actual.Build!=expected.Build)throw new SetupFailure(30,"应用文件验证未完成，请重试安装。");
   Dictionary<string,object> marker=ReadJson(Path.Combine(resources,"installed-runtime.json"));
   if(!marker.ContainsKey("state")||Convert.ToString(marker["state"])!="ready"||!marker.ContainsKey("id")||Convert.ToString(marker["id"])!=BuildInfo.RuntimeId||!marker.ContainsKey("archiveSha256")||Convert.ToString(marker["archiveSha256"])!=BuildInfo.RuntimeArchiveHash)throw new SetupFailure(31,"工作台环境尚未准备完成，请重试安装。");
   if(HashFile(Path.Combine(resources,"app.asar"))!=BuildInfo.AsarHash)throw new SetupFailure(30,"应用文件校验未通过，请重新安装。");
  }
  static void RemoveOwnTemp(string target,string parent){
   if(String.IsNullOrEmpty(target)||!target.StartsWith(parent.TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase)||!Directory.Exists(target))return;
   if((File.GetAttributes(target)&FileAttributes.ReparsePoint)!=0){Directory.Delete(target,false);return;}
   foreach(string file in Directory.GetFiles(target))File.Delete(file);
   foreach(string folder in Directory.GetDirectories(target))RemoveOwnTemp(folder,parent);
   Directory.Delete(target,false);
  }
  internal static void Install(string directory,Action<InstallProgress> progress,CancellationToken cancel){
   string target=NormalizeDirectory(directory);Preflight(target);cancel.ThrowIfCancellationRequested();
   string tempParent=Path.Combine(Path.GetTempPath(),"HamsterAI.Setup"),temp=null;
   try{
    Directory.CreateDirectory(tempParent);RejectLinks(tempParent);temp=Path.Combine(tempParent,Guid.NewGuid().ToString("N"));Directory.CreateDirectory(temp);RejectLinks(temp);
    string engine=Path.Combine(temp,"engine.exe");
    using(Stream input=Assembly.GetExecutingAssembly().GetManifestResourceStream("HamsterSetup.Engine.exe"))using(FileStream output=new FileStream(engine,FileMode.CreateNew,FileAccess.Write,FileShare.None)){
     if(input==null||input.Length!=BuildInfo.BackendSize)throw new SetupFailure(14,"安装包校验未通过，请重新获取安装包。");
     byte[] buffer=new byte[256*1024];long copied=0,lastReport=0;int read;
     while((read=input.Read(buffer,0,buffer.Length))>0){cancel.ThrowIfCancellationRequested();output.Write(buffer,0,read);copied+=read;if(copied-lastReport>=4*1024*1024||copied==BuildInfo.BackendSize){lastReport=copied;progress(new InstallProgress("prepare",copied*100.0/BuildInfo.BackendSize,false,false));}}
    }
    progress(new InstallProgress("verify-package",100,true,false));if(HashFile(engine)!=BuildInfo.BackendHash)throw new SetupFailure(14,"安装包校验未通过，请重新获取安装包。");
    cancel.ThrowIfCancellationRequested();CheckRunning();AttemptedDirectory=target;
    progress(new InstallProgress("install",0,true,true));
    ProcessStartInfo info=new ProcessStartInfo(engine,"/S /currentuser /D="+target);info.UseShellExecute=false;info.CreateNoWindow=true;info.WindowStyle=ProcessWindowStyle.Hidden;info.WorkingDirectory=temp;
    using(Process process=Process.Start(info)){
     if(process==null)throw new SetupFailure(15,"安装程序暂时无法启动，请重试。");string stage="install";
     while(!process.WaitForExit(400)){string next=CurrentStage(target);if(next=="install"&&stage!="install")next="finishing";if(next!=stage){stage=next;progress(new InstallProgress(stage,0,true,true));}}
     if(process.ExitCode==20)throw new SetupFailure(20,"仓鼠AI正在运行。请先保存工作并退出仓鼠AI，再点击重试。");
     if(process.ExitCode==21)throw new SetupFailure(21,"暂时无法检查应用运行状态，请稍后重试。");
     if(process.ExitCode!=0)throw new SetupFailure(16,"安装未能完成。请检查可用空间和目录权限后重试。已有个人设置和作品不会由此界面清除。");
    }
    progress(new InstallProgress("verify-install",100,true,true));Verify(target);progress(new InstallProgress("complete",100,false,true));
   }finally{try{RemoveOwnTemp(temp,tempParent);}catch{/* No customer directory is cleaned up. */}}
  }
 }
 internal sealed class SetupWindow {
  readonly Window window;readonly string qaRoot;readonly bool preview;readonly string initialDirectory;
  CancellationTokenSource cancellation;bool busy,engineStarted,closeRequested,completed;
  readonly List<string> stages=new List<string>();
  T Find<T>(string name) where T:class{return window.FindName(name) as T;}
  internal SetupWindow(string[] args){
   qaRoot=Argument(args,"--qa-root=");preview=args.Contains("--preview")||Argument(args,"--preview=")!=null;
   using(Stream xaml=Assembly.GetExecutingAssembly().GetManifestResourceStream("HamsterSetup.Shell.xaml"))window=(Window)XamlReader.Load(xaml);
   window.Width=Math.Min(window.Width,SystemParameters.WorkArea.Width-24);window.Height=Math.Min(window.Height,SystemParameters.WorkArea.Height-24);
   foreach(string name in new string[]{"CloseButton","MinimizeButton","DirectoryBox","BrowseButton","StartButton","LaunchButton","DoneButton","RetryButton","ErrorCloseButton"}){FrameworkElement element=Find<FrameworkElement>(name);if(element!=null)AutomationProperties.SetAutomationId(element,name);}
   Find<TextBlock>("VersionText").Text="版本 "+BuildInfo.Version+"  ·  Windows 64 位";
   Find<TextBlock>("InstallInfo").Text="完整离线安装 · 约需 "+(BuildInfo.RequiredInstallBytes/(1024.0*1024*1024)).ToString("0.0",CultureInfo.InvariantCulture)+" GB 可用空间";
   initialDirectory=Argument(args,"--qa-install=");string existing=preview?null:InstallCore.ExistingDirectory();
   Find<TextBox>("DirectoryBox").Text=preview?"C:\\Apps\\仓鼠AI":initialDirectory??existing??InstallCore.DefaultDirectory();
   if(!String.IsNullOrEmpty(existing)&&initialDirectory==null){Find<TextBlock>("ReadyTitle").Text="让创作，继续向前";Find<TextBlock>("ReadySubtitle").Text="更新仓鼠AI，继续你的创作。个人设置与作品保持原样。";Find<Button>("StartButton").Content="更新仓鼠AI";Find<TextBox>("DirectoryBox").IsReadOnly=true;Find<Button>("BrowseButton").IsEnabled=false;}
   LoadLogo();
   Find<Button>("CloseButton").Click+=delegate{RequestClose();};Find<Button>("MinimizeButton").Click+=delegate{window.WindowState=WindowState.Minimized;};
   Find<Button>("DoneButton").Click+=delegate{window.Close();};Find<Button>("ErrorCloseButton").Click+=delegate{window.Close();};
   Find<Button>("BrowseButton").Click+=delegate{Browse();};Find<Button>("StartButton").Click+=async delegate{await Start();};Find<Button>("RetryButton").Content="返回重试";Find<Button>("RetryButton").Click+=delegate{ShowPage("PageReady");Find<TextBox>("DirectoryBox").Focus();};
   Find<Button>("LaunchButton").Click+=delegate{Launch();};
   Find<FrameworkElement>("TitleBar").MouseLeftButtonDown+=delegate(object sender,MouseButtonEventArgs e){if(e.ChangedButton==MouseButton.Left&&!(e.OriginalSource is Button)){try{window.DragMove();}catch{}}};
   window.Closing+=delegate(object sender,CancelEventArgs e){if(busy){e.Cancel=true;RequestClose();}};
   window.KeyDown+=delegate(object sender,KeyEventArgs e){if(e.Key==Key.Escape){RequestClose();e.Handled=true;}};
   window.ContentRendered+=async delegate{
    if(preview){string stage=Argument(args,"--preview=")??"ready";if(stage=="installing")ApplyProgress(new InstallProgress("runtime",0,true,true));else if(stage=="complete")ShowPage("PageComplete");else if(stage=="error")ShowError(new SetupFailure(13,"该目录不可写。请选择当前用户有写入权限的文件夹后重试。"));Capture("preview-"+stage);}
    else if(initialDirectory!=null&&AuthorizedQa()){Capture("ready");await Start();if(args.Contains("--qa-auto-close"))window.Close();}
   };
  }
  internal static string Argument(string[] args,string prefix){return args.FirstOrDefault(arg=>arg.StartsWith(prefix,StringComparison.Ordinal))==null?null:args.First(arg=>arg.StartsWith(prefix,StringComparison.Ordinal)).Substring(prefix.Length);}
  internal static string SilentDirectory(){
   System.Text.RegularExpressions.Match match=System.Text.RegularExpressions.Regex.Match(Environment.CommandLine,"(?:^|\\s)(\"?)/D=(.*)$");if(!match.Success)return null;string value=match.Groups[2].Value.Trim();
   if(match.Groups[1].Value=="\""&&value.EndsWith("\"",StringComparison.Ordinal))value=value.Substring(0,value.Length-1);
   else if(value.Length>=2&&value.StartsWith("\"",StringComparison.Ordinal)&&value.EndsWith("\"",StringComparison.Ordinal))value=value.Substring(1,value.Length-2);
   return value;
  }
  bool AuthorizedQa(){try{return !String.IsNullOrEmpty(qaRoot)&&Path.IsPathRooted(qaRoot)&&File.ReadAllText(Path.Combine(qaRoot,"setup-qa-authorized.txt")).Trim()==InstallCore.ProductGuid;}catch{return false;}}
  void LoadLogo(){try{using(Stream stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("HamsterSetup.Logo.png")){BitmapImage image=new BitmapImage();image.BeginInit();image.CacheOption=BitmapCacheOption.OnLoad;image.StreamSource=stream;image.EndInit();image.Freeze();Find<Image>("BrandLogo").Source=image;}}catch{}}
  internal void Run(){window.Show();}
  void ShowPage(string name){foreach(string page in new string[]{"PageReady","PageInstalling","PageComplete","PageError"})Find<FrameworkElement>(page).Visibility=page==name?Visibility.Visible:Visibility.Collapsed;}
  void RequestClose(){if(!busy){window.Close();return;}if(!engineStarted){closeRequested=true;cancellation.Cancel();Find<TextBlock>("StageText").Text="正在取消，请稍候…";}}
  void Browse(){using(System.Windows.Forms.FolderBrowserDialog dialog=new System.Windows.Forms.FolderBrowserDialog()){dialog.Description="选择仓鼠AI安装位置";try{dialog.SelectedPath=Path.GetDirectoryName(Find<TextBox>("DirectoryBox").Text);}catch{dialog.SelectedPath=Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);}if(dialog.ShowDialog()==System.Windows.Forms.DialogResult.OK){string selected=dialog.SelectedPath;Find<TextBox>("DirectoryBox").Text=Path.GetFileName(selected)=="仓鼠AI"?selected:Path.Combine(selected,"仓鼠AI");}}}
  async Task Start(){
   if(busy||preview)return;string directory;
   try{directory=InstallCore.NormalizeDirectory(Find<TextBox>("DirectoryBox").Text);InstallCore.Preflight(directory);}catch(Exception error){ShowPage("PageReady");Find<TextBlock>("ReadyError").Text=error is SetupFailure?error.Message:"请选择有效且可写的安装目录。";Find<TextBlock>("ReadyError").Visibility=Visibility.Visible;Find<TextBox>("DirectoryBox").Focus();WriteQa(false,error is SetupFailure?((SetupFailure)error).Code:1);Capture("error");return;}
   Find<TextBlock>("ReadyError").Visibility=Visibility.Collapsed;
   busy=true;engineStarted=false;closeRequested=false;completed=false;cancellation=new CancellationTokenSource();ShowPage("PageInstalling");
   try{await Task.Run(()=>InstallCore.Install(directory,value=>window.Dispatcher.BeginInvoke(new Action(()=>ApplyProgress(value))),cancellation.Token));busy=false;completed=true;Find<Button>("CloseButton").IsEnabled=true;ShowPage("PageComplete");Find<TextBlock>("FinishTitle").Text="准备就绪，即刻创作";Find<TextBlock>("FinishSubtitle").Text="仓鼠AI已安装完成。打开应用，开始你的下一个作品。";Capture("complete");WriteQa(true,0);}
   catch(OperationCanceledException){busy=false;ShowPage("PageReady");WriteQa(false,2);if(closeRequested)window.Close();}
   catch(Exception error){busy=false;Find<Button>("CloseButton").IsEnabled=true;ShowError(error);Capture("error");WriteQa(false,error is SetupFailure?((SetupFailure)error).Code:1);}
   finally{if(cancellation!=null)cancellation.Dispose();}
  }
  void ApplyProgress(InstallProgress value){
   engineStarted=value.EngineStarted;if(stages.Count==0||stages[stages.Count-1]!=value.Stage)stages.Add(value.Stage);
   Find<Button>("CloseButton").IsEnabled=!value.EngineStarted;
   ProgressBar bar=Find<ProgressBar>("ProgressBar");bar.IsIndeterminate=value.Indeterminate;bar.Value=value.Percent;
   string title=value.Stage=="prepare"?"正在准备安装文件":value.Stage=="verify-package"?"正在校验安装包":value.Stage=="runtime"?"正在配置工作台环境":value.Stage=="finishing"?"正在完成安装":value.Stage=="verify-install"?"正在验证安装结果":value.Stage=="complete"?"安装已完成":"正在安装仓鼠AI";
   Find<TextBlock>("StageText").Text=title;Find<TextBlock>("ProgressCaption").Text=value.Indeterminate?"正在进行，请稍候":value.Stage=="prepare"?"已准备 "+Math.Floor(value.Percent).ToString(CultureInfo.InvariantCulture)+"%":"已完成";
   Find<TextBlock>("InstallStatusHint").Text=value.EngineStarted?"安装期间可最小化窗口，请保持安装程序运行。":"正在本机准备安装所需文件。";
   Find<TextBlock>("StepPrepare").Foreground=value.Stage=="prepare"||value.Stage=="verify-package"?Brushes.ForestGreen:Brushes.DarkSlateGray;
   Find<TextBlock>("StepInstall").Foreground=value.Stage=="install"?Brushes.ForestGreen:Brushes.DarkSlateGray;
   Find<TextBlock>("StepRuntime").Foreground=value.Stage=="runtime"||value.Stage=="verify-install"?Brushes.ForestGreen:Brushes.DarkSlateGray;
   if(value.Stage=="install"||value.Stage=="runtime")Capture(value.Stage);
  }
  void ShowError(Exception error){ShowPage("PageError");Find<TextBlock>("ErrorTitle").Text="暂时未能完成安装";Find<TextBlock>("ErrorText").Text=error is SetupFailure?error.Message:"安装遇到问题。请检查磁盘空间与目录权限后重试。";Find<Button>("RetryButton").IsEnabled=!preview;}
  void Launch(){if(!completed||preview)return;try{string target=InstallCore.NormalizeDirectory(Find<TextBox>("DirectoryBox").Text);InstallCore.Verify(target);Process.Start(new ProcessStartInfo(Path.Combine(target,InstallCore.Executable)){UseShellExecute=false,WorkingDirectory=target});window.Close();}catch{ShowError(new SetupFailure(32,"应用暂时无法打开，请从桌面快捷方式重试。"));}}
  void Capture(string name){if(!AuthorizedQa())return;try{window.Dispatcher.Invoke(new Action(()=>{window.UpdateLayout();RenderTargetBitmap bitmap=new RenderTargetBitmap((int)Math.Ceiling(window.ActualWidth),(int)Math.Ceiling(window.ActualHeight),96,96,PixelFormats.Pbgra32);bitmap.Render(window);PngBitmapEncoder encoder=new PngBitmapEncoder();encoder.Frames.Add(BitmapFrame.Create(bitmap));using(FileStream file=new FileStream(Path.Combine(qaRoot,"installer-"+name+".png"),FileMode.Create,FileAccess.Write))encoder.Save(file);}));}catch{}}
  void WriteQa(bool success,int code){if(!AuthorizedQa())return;try{Dictionary<string,object> result=new Dictionary<string,object>();result["version"]=BuildInfo.Version;result["passed"]=success;result["code"]=code;result["stages"]=stages.ToArray();result["customWindow"]=window.WindowStyle==WindowStyle.None;result["readyStartWired"]=Find<Button>("StartButton")!=null;result["completedLaunchEnabled"]=success&&Find<Button>("LaunchButton").IsEnabled;result["realCustomerData"]=false;result["realGenerationCalls"]=0;File.WriteAllText(Path.Combine(qaRoot,"setup-ui-result.json"),new JavaScriptSerializer().Serialize(result));}catch{}}
 }
 internal static class Program {
  [STAThread] static int Main(string[] args){
   try{
    if(args.Contains("/S")){string directory=SetupWindow.SilentDirectory()??InstallCore.ExistingDirectory()??InstallCore.DefaultDirectory();InstallCore.Install(directory,delegate{},CancellationToken.None);return 0;}
    Application app=new Application();app.ShutdownMode=ShutdownMode.OnLastWindowClose;SetupWindow setup=new SetupWindow(args);setup.Run();return app.Run();
   }catch(SetupFailure error){return error.Code;}catch{return 1;}
  }
 }
}
