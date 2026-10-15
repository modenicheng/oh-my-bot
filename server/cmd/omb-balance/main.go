package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"os"
	"time"

	ombv1 "github.com/modenicheng/oh-my-bot/server/internal/protocol/gen/proto"
	"github.com/modenicheng/oh-my-bot/server/internal/script"
	"github.com/modenicheng/oh-my-bot/server/internal/sim"
)

type metrics struct {
	Scenario    string  `json:"scenario"`
	Strategy    string  `json:"strategy"`
	Distance    float64 `json:"distance"`
	Level       uint8   `json:"shield_level"`
	Runs        int     `json:"runs"`
	Seconds     float64 `json:"seconds"`
	Damage      float64 `json:"damage"`
	Hits        int     `json:"hits"`
	Blocked     int     `json:"blocked_hits"`
	Shots       int     `json:"shots"`
	ShieldTicks int     `json:"shield_ticks"`
	DashTicks   int     `json:"dash_ticks"`
	Energy      float64 `json:"final_energy"`
	Movement    float64 `json:"distance_moved"`
}

type eventSink struct{ result *metrics }

func (sink eventSink) OnEvent(_ uint32, event *ombv1.ServerEvent) {
	if impact := event.GetProjectileImpact(); impact != nil && impact.Target == 1 {
		sink.result.Hits++
		if impact.Shield {
			sink.result.Blocked++
		}
	}
	if shot := event.GetShot(); shot != nil && shot.Owner != 1 {
		sink.result.Shots++
	}
}

func main() {
	oraclePath := flag.String("oracle", "", "compiled Oracle JavaScript")
	seeds := flag.Int("seeds", 8, "number of paired seeds per case")
	seconds := flag.Int("seconds", 12, "duration of each sample")
	flag.Parse()
	if *seeds < 1 || *seconds < 1 || *seconds > 120 {
		panic("invalid experiment bounds")
	}
	oracle, err := os.ReadFile(*oraclePath)
	if err != nil {
		panic(err)
	}
	encoder := json.NewEncoder(os.Stdout)
	for _, attackers := range []int{1, 2} {
		for _, level := range []uint8{0, 10} {
			for _, distance := range []float64{4, 8, 12, 16} {
				for _, strategy := range []string{"stationary", "strafe", "dash-strafe", "shield", "shield-early", "shield-late", "oracle"} {
					result := metrics{Scenario: fmt.Sprintf("%d-shooters", attackers), Strategy: strategy, Distance: distance, Level: level}
					for seed := 1; seed <= *seeds; seed++ {
						for _, mirror := range []float64{-1, 1} {
							if err := sample(uint64(seed), mirror, attackers, *seconds, string(oracle), &result); err != nil {
								panic(err)
							}
							result.Runs++
						}
					}
					result.Energy /= float64(result.Runs)
					if err := encoder.Encode(result); err != nil {
						panic(err)
					}
				}
			}
		}
	}
}

const attackerSource = `function tick(bot) {
 const enemy = bot.nearestEnemy();
 if (!enemy) return;
 const dx = enemy.position.x-bot.self.position.x, dy = enemy.position.y-bot.self.position.y;
 const vx = enemy.velocity.x, vy = enemy.velocity.y, speed = 36;
 const coefficient = vx*vx+vy*vy-speed*speed;
 const linear = 2*(dx*vx+dy*vy), constant = dx*dx+dy*dy;
 const discriminant = linear*linear-4*coefficient*constant;
 let flight = Math.hypot(dx,dy)/speed;
 if (discriminant >= 0 && Math.abs(coefficient)>1e-6) flight = Math.max(0,(-linear-Math.sqrt(discriminant))/(2*coefficient));
 bot.aimAt(Math.atan2(dy+vy*(flight+1/60),dx+vx*(flight+1/60)));
 bot.fire();
}`

const defenderSource = `function tick(bot) {
 const observation = bot.scan(), now = observation.tick, position = bot.self.position;
 const strategy = STRATEGY;
 if (strategy === "strafe" || strategy === "dash-strafe") {
   bot.move(0, Math.floor(now/12)%2 === 0 ? 1 : -1);
   if(strategy === "dash-strafe") bot.dash();
 }
 let threat = Infinity;
 for(const projectile of observation.projectiles) {
   if(projectile.owner===bot.self.id) continue;
   const dx=projectile.x-position.x, dy=projectile.y-position.y;
   const vx=Math.cos(projectile.heading)*36-bot.self.velocity.x, vy=Math.sin(projectile.heading)*36-bot.self.velocity.y;
   const arrival=-(dx*vx+dy*vy)/(vx*vx+vy*vy);
   if(arrival>=0 && Math.hypot(dx+vx*arrival,dy+vy*arrival)<0.65) threat=Math.min(threat,arrival-0.6/36);
 }
 const advance=strategy==="shield-early"?5:strategy==="shield-late"?0:2;
 bot.shield(strategy.startsWith("shield") && threat<=advance/60 && now+1 >= (bot.self.shieldReadyTick||0));
}`

func sample(seed uint64, mirror float64, attackers, seconds int, oracle string, result *metrics) error {
	ids := []uint32{1, 2}
	if attackers == 2 {
		ids = append(ids, 3)
	}
	world := sim.NewSim(seed, ids, eventSink{result})
	if err := world.SetSpawn(1, sim.Vec2{}, 0); err != nil {
		return err
	}
	for index := 0; index < attackers; index++ {
		angle := 0.0
		if index == 1 {
			angle = math.Pi / 2
		}
		if err := world.SetSpawn(uint32(index+2), sim.Vec2{X: mirror * result.Distance * math.Cos(angle), Y: result.Distance * math.Sin(angle)}, uint32(index+1)); err != nil {
			return err
		}
	}
	checkpoint := world.Snapshot()
	checkpoint.Robots[0].Upg.Levels[sim.TrackShield] = result.Level
	var err error
	world, err = sim.RestoreCheckpoint(checkpoint, eventSink{result})
	if err != nil {
		return err
	}
	runtimes := make(map[uint32]*script.GojaRuntime)
	for _, robotID := range ids {
		runtime := script.NewGojaRuntime(script.Config{TickTimeout: time.Second})
		defer runtime.Close()
		source := attackerSource
		if robotID == 1 {
			if result.Strategy == "oracle" {
				source = oracle
				if os.Getenv("OMB_BALANCE_TRACE") != "" {
					for _, name := range []string{"buyUpgrades", "updateKinematics", "currentTarget", "idleWander", "aimWithLead", "defend"} {
						source += fmt.Sprintf("\nconst trace_%s=%s; %s=function(...args){console.log('enter %s'); const result=trace_%s(...args); console.log('exit %s');return result;};\n", name, name, name, name, name, name)
					}
				}
			} else {
				source = fmt.Sprintf("const STRATEGY=%q;\n", result.Strategy) + defenderSource
			}
		}
		if err := runtime.Load(source); err != nil {
			return err
		}
		runtimes[robotID] = runtime
		world.AssistToggle(robotID)
	}
	previous := sim.Vec2{}
	for tick := 0; tick < seconds*sim.TickRate; tick++ {
		view := world.WorldView()
		for _, robotID := range ids {
			robot, _ := world.Robot(robotID)
			if robot.State == sim.Dead {
				continue
			}
			observation, _ := view.Observe(robotID)
			var self sim.RobotView
			for _, visible := range observation.Robots {
				if visible.ID == robotID {
					self = visible
				}
			}
			command, err := runtimes[robotID].Tick(sim.ScriptFrame{Self: self, Obs: observation, Upg: robot.Upg, ShieldReady: robot.Combat.ShieldReady, ShieldStarted: robot.Combat.ShieldStarted})
			if err != nil {
				return fmt.Errorf("seed %d %s tick %d: %w logs=%v", seed, result.Strategy, tick, err, runtimes[robotID].DrainLogs())
			}
			runtimes[robotID].DrainLogs()
			world.ApplyScriptCommands(robotID, command)
		}
		world.Tick()
		robot, _ := world.Robot(1)
		result.Seconds += sim.DT
		result.Movement += robot.Position.Sub(previous).Len()
		previous = robot.Position
		if robot.Combat.ShieldOn {
			result.ShieldTicks++
		}
		if robot.Combat.DashUntil > world.CurrentTick() {
			result.DashTicks++
		}
		if robot.State == sim.Dead {
			break
		}
	}
	robot, _ := world.Robot(1)
	result.Energy += robot.Energy
	result.Damage += sim.MaxHP - robot.HP
	return nil
}
