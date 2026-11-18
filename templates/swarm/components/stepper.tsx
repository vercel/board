import type { ReactNode } from "react";
import { Check, Circle } from "lucide-react";
import { isDone, type Step, type Task } from "@/lib/setup";
import { Copy } from "./copy";

const icon = { size: 14, strokeWidth: 2.5, role: "img" } as const;

/** One task: what to do, with the names in it set apart, then what helps do it: a line with its link in it, and each command in its own box. */
function TaskItem({ task }: { task: Task }): ReactNode {
  return (
    <li className="task" data-done={task.done ? "" : undefined}>
      {task.done ? <Check {...icon} aria-label="Done" /> : <Circle {...icon} aria-label="To do" />}
      <div>
        <p>{task.label.split("`").map((part, i) => (i % 2 ? <code key={i}>{part}</code> : part))}</p>
        {task.hint || task.link ? (
          <p className="hint">
            {task.hint}
            {task.hint && task.link ? " " : null}
            {task.link ? (
              <a href={task.link.href} target="_blank" rel="noreferrer">
                {task.link.label}
              </a>
            ) : null}
          </p>
        ) : null}
        {task.commands?.map((command) => (
          <div key={command} className="command">
            <pre>
              <code>{command}</code>
            </pre>
            <Copy text={command} />
          </div>
        ))}
      </div>
    </li>
  );
}

export function Tasks({ tasks }: { tasks: Task[] }): ReactNode {
  return (
    <ul className="tasks">
      {tasks.map((task) => (
        <TaskItem key={task.label} task={task} />
      ))}
    </ul>
  );
}

/** The steps, in order, each with its tasks. */
export function Stepper({ steps }: { steps: Step[] }): ReactNode {
  return (
    <ol className="stepper">
      {steps.map((step, i) => {
        const done = isDone(step);
        return (
          <li key={step.id} className="step" data-done={done ? "" : undefined}>
            <span className="marker">{done ? <Check size={14} strokeWidth={2.5} aria-hidden /> : <span>{i + 1}</span>}</span>
            <div className="step-body">
              <div className="step-head">
                <h2>{step.title}</h2>
              </div>
              <Tasks tasks={step.tasks} />
            </div>
          </li>
        );
      })}
    </ol>
  );
}
