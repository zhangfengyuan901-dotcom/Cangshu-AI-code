using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace HamsterSetup {
 internal static class CoreTests {
  static readonly List<Dictionary<string,object>> Cases=new List<Dictionary<string,object>>();
  static readonly JavaScriptSerializer Json=new JavaScriptSerializer();
  static void Assert(bool value){if(!value)throw new InvalidOperationException("assertion");}
  static void Run(string name,Action test){
   Dictionary<string,object> result=new Dictionary<string,object>();result["name"]=name;
   try{test();result["passed"]=true;}
   catch(SetupFailure failure){result["passed"]=false;result["code"]=failure.Code;}
   catch{result["passed"]=false;result["code"]="assertion_or_unexpected_exception";}
   Cases.Add(result);
  }
  static void Reject(string name,string value){Run(name,delegate{try{InstallCore.NormalizeDirectory(value);throw new InvalidOperationException("accepted");}catch(SetupFailure failure){Assert(failure.Code==10);}});}
  static string Hash(string file){using(SHA256 hash=SHA256.Create())using(FileStream stream=File.OpenRead(file))return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-","");}
  static string[] Entries(string directory){return Directory.GetFileSystemEntries(directory).Select(Path.GetFileName).OrderBy(value=>value,StringComparer.Ordinal).ToArray();}
  static void EqualEntries(string[] before,string directory){Assert(before.SequenceEqual(Entries(directory)));}
  static bool SilentProbe(string directory,int style){
   string encoded=Convert.ToBase64String(Encoding.UTF8.GetBytes(directory));
   string tail=style==1?"/D=\""+directory+"\"":style==2?"\"/D="+directory+"\"":"/D="+directory;
   ProcessStartInfo info=new ProcessStartInfo(Assembly.GetExecutingAssembly().Location,"--silent-probe --expected64="+encoded+" /S "+tail);
   info.UseShellExecute=false;info.CreateNoWindow=true;info.RedirectStandardOutput=true;info.RedirectStandardError=true;
   using(Process child=Process.Start(info)){
    if(child==null)return false;
    if(!child.WaitForExit(15000)){child.Kill();return false;}
    string output=child.StandardOutput.ReadToEnd();child.StandardError.ReadToEnd();
    Dictionary<string,object> value=Json.Deserialize<Dictionary<string,object>>(output);
    return child.ExitCode==0&&value.ContainsKey("passed")&&value["passed"] is bool&&(bool)value["passed"];
   }
  }
  static int Probe(string[] args){
   try{string encoded=args.First(value=>value.StartsWith("--expected64=",StringComparison.Ordinal)).Substring(13);string expected=Encoding.UTF8.GetString(Convert.FromBase64String(encoded));bool passed=String.Equals(SetupWindow.SilentDirectory(),expected,StringComparison.Ordinal);Console.WriteLine(Json.Serialize(new {passed=passed}));return passed?0:1;}
   catch{Console.WriteLine("{\"passed\":false}");return 1;}
  }
  [STAThread] internal static int Main(string[] args){
   if(args.Contains("--silent-probe"))return Probe(args);
   string previousTemp=Environment.GetEnvironmentVariable("TEMP"),previousTmp=Environment.GetEnvironmentVariable("TMP");bool pathsOnly=args.Contains("--paths-only");
   try{
    string supplied=args.FirstOrDefault(value=>value.StartsWith("--fixture=",StringComparison.Ordinal));Assert(supplied!=null);
    string fixture=supplied.Substring(10);Assert(Path.IsPathRooted(fixture));fixture=Path.GetFullPath(fixture).TrimEnd('\\');
    string own=Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
    Assert(InstallCore.SamePath(fixture,own)&&new DirectoryInfo(fixture).Parent.Name=="qa-core");InstallCore.RejectLinks(fixture);
    string temporary=Path.Combine(fixture,"temp");Directory.CreateDirectory(temporary);Environment.SetEnvironmentVariable("TEMP",temporary);Environment.SetEnvironmentVariable("TMP",temporary);
    Run("test-assembly-has-no-engine-or-ui-resources",delegate{Assert(Assembly.GetExecutingAssembly().GetManifestResourceNames().Length==0);});
    Reject("reject-volume-root",Path.GetPathRoot(fixture));
    Reject("reject-windows-root",Environment.GetFolderPath(Environment.SpecialFolder.Windows));
    Reject("reject-windows-descendant",Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),"System32","HamsterCoreFixture"));
    Reject("reject-user-profile-root",Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));
    Reject("reject-UNC-path-before-network-access","\\\\unavailable.invalid\\share\\HamsterCoreFixture");
    Reject("reject-relative-path","HamsterCoreFixture");
    Reject("reject-drive-relative-path",Path.GetPathRoot(fixture).Substring(0,2)+"HamsterCoreFixture");
    Reject("reject-parent-traversal",Path.Combine(fixture,"..","escape"));
    Reject("reject-forward-parent-traversal",fixture.Replace('\\','/')+"/../escape");
    Reject("reject-quote",fixture+"\\bad\"name");
    Reject("reject-newline",fixture+"\\bad\nname");
    Reject("reject-NUL",fixture+"\\bad\0name");
    Reject("reject-trailing-period",fixture+"\\bad.");
    Reject("reject-alternate-stream-colon",fixture+"\\bad:stream");
    Reject("reject-empty-path","");
    string occupiedFile=Path.Combine(fixture,"occupied-file.bin");File.WriteAllText(occupiedFile,"synthetic-guard");string occupiedHash=Hash(occupiedFile);
    Reject("reject-existing-file-target",occupiedFile);
    Run("rejected-file-target-remains-unchanged",delegate{Assert(Hash(occupiedFile)==occupiedHash);});
    Run("accept-Chinese-and-space-directory",delegate{string target=Path.Combine(fixture,"中文 空格目录");Assert(InstallCore.NormalizeDirectory(target)==target&&!Directory.Exists(target));});
    Run("normalize-explicit-drive-path-and-separators",delegate{string value=fixture.Replace('\\','/')+"/中文 空格//应用/";Assert(InstallCore.NormalizeDirectory(value)==Path.Combine(fixture,"中文 空格","应用"));});
    Run("normalize-surrounding-input-whitespace",delegate{string target=Path.Combine(fixture,"应用");Assert(InstallCore.NormalizeDirectory("  "+target+"  ")==target);});
    string unknown=Path.Combine(fixture,"unknown-nonempty");Directory.CreateDirectory(unknown);string sentinel=Path.Combine(unknown,"guard.bin");File.WriteAllText(sentinel,"synthetic-owned-fixture");string sentinelHash=Hash(sentinel);string[] unknownBefore=Entries(unknown);
    Run("unknown-nonempty-directory-is-rejected-without-mutation",delegate{try{InstallCore.ValidateOwnership(unknown);throw new InvalidOperationException("accepted");}catch(SetupFailure failure){Assert(failure.Code==11);}EqualEntries(unknownBefore,unknown);Assert(Hash(sentinel)==sentinelHash);});
    string empty=Path.Combine(fixture,"empty-target");Directory.CreateDirectory(empty);
    Run("empty-directory-ownership-check-does-not-write",delegate{InstallCore.ValidateOwnership(empty);Assert(Entries(empty).Length==0);});
    Run("absent-directory-ownership-check-does-not-create",delegate{string target=Path.Combine(fixture,"ownership-future");InstallCore.ValidateOwnership(target);Assert(!Directory.Exists(target));});
    Run("silent-parser-without-D-returns-null",delegate{Assert(SetupWindow.SilentDirectory()==null);});
    string silent=Path.Combine(fixture,"中文 安装","仓鼠AI");
    Run("raw-silent-D-retains-Chinese-spaces-in-real-process",delegate{Assert(SilentProbe(silent,0));});
    Run("quoted-silent-D-value-retains-spaces-in-real-process",delegate{Assert(SilentProbe(silent,1));});
    Run("quoted-whole-silent-D-argument-retains-spaces-in-real-process",delegate{Assert(SilentProbe(silent,2));});
    if(!pathsOnly){
     Run("preflight-absent-target-leaves-no-directory-or-probe",delegate{string target=Path.Combine(fixture,"preflight-future","中文 应用");string[] before=Entries(fixture);InstallCore.Preflight(target);Assert(!Directory.Exists(target)&&!Directory.Exists(Path.GetDirectoryName(target)));EqualEntries(before,fixture);});
     Run("preflight-existing-empty-target-remains-empty",delegate{InstallCore.Preflight(empty);Assert(Entries(empty).Length==0);});
     Run("precancelled-install-exits-before-payload-and-target-creation",delegate{string target=Path.Combine(fixture,"cancel-future","仓鼠AI");string[] before=Entries(fixture),tempBefore=Entries(temporary);bool reported=false;using(CancellationTokenSource cancel=new CancellationTokenSource()){cancel.Cancel();try{InstallCore.Install(target,delegate{reported=true;},cancel.Token);throw new InvalidOperationException("not-cancelled");}catch(OperationCanceledException){}}Assert(!reported&&!Directory.Exists(target)&&InstallCore.AttemptedDirectory==null);EqualEntries(before,fixture);EqualEntries(tempBefore,temporary);});
    }
    bool success=Cases.All(value=>(bool)value["passed"]);Console.WriteLine(Json.Serialize(new {format=1,version=BuildInfo.Version,passed=success,scope=pathsOnly?"core-paths-only":"core-full-no-install",tests=Cases.Count,pass=Cases.Count(value=>(bool)value["passed"]),fail=Cases.Count(value=>!(bool)value["passed"]),deferred=pathsOnly?3:0,fixtureIsolated=true,productRegistryWrites=0,innerEngineRuns=0,windowsUiCreated=false,cases=Cases}));return success?0:1;
   }catch{Console.WriteLine("{\"format\":1,\"passed\":false,\"code\":\"CORE_FIXTURE_INVALID\",\"innerEngineRuns\":0,\"windowsUiCreated\":false}");return 1;}
   finally{Environment.SetEnvironmentVariable("TEMP",previousTemp);Environment.SetEnvironmentVariable("TMP",previousTmp);}
  }
 }
}
