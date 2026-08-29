using Newtonsoft.Json;

var json = JsonConvert.SerializeObject(new { hello = "world" });
System.Console.WriteLine(json);
